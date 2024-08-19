import EventEmitter from 'node:events';
import { Executor, GetMethodArgs, RunTransactionArgs } from '../executor/Executor';
import { Cell, TupleItem } from '@ton/core';

export type SourceMapEntry = ({
    path: string;
    line: number;
    function: string;
}) & ({
    type: 'statement';
    variables: string[];
    firstStatement?: true;
} | {
    type: 'return';
} | {
    type: 'catch';
});

export type SourceMap = {
    [k: number]: SourceMapEntry;
};

export type GlobalEntry = {
    name: string;
};

export type DebugInfo = {
    sourceMap: SourceMap;
    globals: GlobalEntry[];
};

type Breakpoint = {
    id: number;
    line: number;
    verified: boolean;
};

export type Variable = {
    name: string;
    value: TupleItem;
};

type StackFrame = {
    function: string;
    path: string;
    line: number;
};

export class Debuggee extends EventEmitter {
    executor: Executor;
    ptr: number = 0;
    debugType: 'get' | 'tx' = 'get';
    sourceMap: SourceMap = {};
    availableLines: { [k: string]: number[] } = {};
    codeCells: Map<string, Cell> = new Map();
    breakpoints: Map<string, Breakpoint[]> = new Map();
    breakpointID: number = 0;
    frames: StackFrame[] = [];
    globals: GlobalEntry[] = [];
    finishedCallback: (v: any) => void;

    constructor(executor: Executor, finishedCallback: (v: any) => void) {
        super();
        this.executor = executor;
        this.executor.debugLogFunc = (s: string) => { this.sendEvent('output', s) };
        this.finishedCallback = finishedCallback;
    }

    setCodeCells(code: Cell) {
        const q: Cell[] = [code];
        while (q.length > 0) {
            const c = q.pop()!;
            const h = c.hash().toString('hex').toUpperCase();
            this.codeCells.set(h, c);
            for (const r of c.refs) {
                q.push(r);
            }
        }
    }

    setDebugInfo(debugInfo: DebugInfo) {
        this.setSourceMap(debugInfo.sourceMap);
        this.setGlobals(debugInfo.globals);
    }

    setSourceMap(sourceMap: SourceMap) {
        this.sourceMap = sourceMap;
        for (const di in sourceMap) {
            const sem = sourceMap[di];
            if (!(sem.path in this.availableLines)) {
                this.availableLines[sem.path] = [];
            }
            this.availableLines[sem.path].push(sem.line);
        }
    }

    setGlobals(globals: GlobalEntry[]) {
        this.globals = globals;
    }

    getAvailableSourcePaths() {
        return Object.keys(this.availableLines);
    }

    getAvailableLines(path: string) {
        return this.availableLines[path] ?? [];
    }

    isLineAvailable(path: string, line: number) {
        if (!(path in this.availableLines)) {
            return false
        }
        const lines = this.availableLines[path]
        return lines.indexOf(line) >= 0
    }

    continue() {
        this.stepUntil({ type: 'breakpoint' });
    }

    stepIn() {
        this.stepUntil({ type: 'any-line', stopEvent: 'stopOnStep' });
    }

    stepOver() {
        this.stepUntil({ type: 'next-line' });
    }

    stepOut() {
        this.stepUntil({ type: 'out' });
    }

    startGetMethod(args: GetMethodArgs) {
        this.ptr = this.executor.sbsGetMethodSetup(args);
        this.debugType = 'get';
    }

    startTransaction(args: RunTransactionArgs) {
        const { emptr, res } = this.executor.sbsTransactionSetup(args);
        if (res !== 1) {
            throw new Error('Could not setup SBS transaction, result: ' + res);
        }
        this.ptr = emptr;
        this.debugType = 'tx';
    }

    getC7() {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodC7(this.ptr);
            case 'tx':
                return this.executor.sbsTransactionC7(this.ptr);
        }
    }

    vmStep() {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodStep(this.ptr);
            case 'tx':
                return this.executor.sbsTransactionStep(this.ptr);
        }
    }

    codePos() {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodCodePos(this.ptr);
            case 'tx':
                return this.executor.sbsTransactionCodePos(this.ptr);
        }
    }

    getStack() {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodStack(this.ptr);
            case 'tx':
                return this.executor.sbsTransactionStack(this.ptr);
        }
    }

    getContParam() {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodGetContParam(this.ptr);
            case 'tx':
                return this.executor.sbsTransactionGetContParam(this.ptr);
        }
    }

    setContParam(param: number) {
        switch (this.debugType) {
            case 'get':
                return this.executor.sbsGetMethodSetContParam(this.ptr, param);
            case 'tx':
                return this.executor.sbsTransactionSetContParam(this.ptr, param);
        }
    }

    getLocalVariables(): Variable[] | undefined {
        const sme = this.currentSourceMapEntry();
        if (sme === undefined || sme.type !== 'statement') {
            return undefined;
        }

        const vars: Variable[] = [];

        const stack = this.getStack();
        for (let i = 0; i < sme.variables.length; i++) {
            vars.push({
                name: sme.variables[i],
                value: stack[i],
            });
        }

        return vars;
    }

    getGlobalVariables(): Variable[] | undefined {
        const vars: Variable[] = [];

        const c7item = this.getC7();
        if (c7item.type !== 'tuple') {
            return undefined;
        }
        const c7 = c7item.items;
        for (let i = 0; i < this.globals.length; i++) {
            if (i + 1 < c7.length) {
                vars.push({
                    name: this.globals[i].name,
                    value: c7[i+1],
                });
                continue;
            }

            vars.push({
                name: this.globals[i].name,
                value: { type: 'null' },
            });
        }

        return vars;
    }

    currentDebugInfoNumber() {
        const codepos = this.codePos();
        const cell = this.codeCells.get(codepos.hash);
        if (cell !== undefined) {
            try {
                const s = cell.beginParse()
                s.skip(codepos.offset)
                const opp = s.loadUint(12)
                if (opp !== 0xfef) {
                    return undefined
                }
                const n = s.loadUint(4)
                const b = s.loadBuffer(n+1)
                const bstr = b.toString('utf-8')
                if (!bstr.startsWith('DI')) {
                    return undefined
                }
                return parseInt(bstr.slice(2))
            } catch (e) {}
        }
        return undefined
    }

    currentSourceMapEntry() {
        const di = this.currentDebugInfoNumber()
        if (di === undefined) {
            return undefined
        }
        return this.sourceMap[di]
    }

    breakpointKey(path: string, line: number) {
        return path + ':' + line;
    }

    splitBreakpointKey(k: string) {
        const i = k.lastIndexOf(':');
        return {
            path: k.slice(0, i),
            line: parseInt(k.slice(i+1)),
        };
    }

    clearBreakpoints(path: string) {
        this.breakpoints.set(path, []);
    }

    hasBreakpoint(path: string, line: number) {
        return (this.breakpoints.get(path) ?? []).findIndex(v => v.line === line) >= 0;
    }

    setBreakpoint(path: string, line: number): Breakpoint {
        let arr = this.breakpoints.get(path);
        if (arr === undefined) {
            arr = [];
            this.breakpoints.set(path, arr);
        }
        const bp: Breakpoint = {
            id: this.breakpointID++,
            line,
            verified: this.isLineAvailable(path, line),
        };
        arr.push(bp);
        return bp;
    }

    sendEvent(event: string, ... args: any[]): void {
		setTimeout(() => {
			this.emit(event, ...args);
		}, 0);
	}

    onFinished() {
        this.sendEvent('end')
        let r: any
        switch (this.debugType) {
            case 'get': {
                r = this.executor.sbsGetMethodResult(this.ptr)
                this.executor.destroyTvmEmulator(this.ptr)
                break
            }
            case 'tx': {
                r = this.executor.sbsTransactionResult(this.ptr)
                this.executor.destroyEmulator(this.ptr)
                break
            }
        }

        this.finishedCallback(r)
    }

    stackFrames(): StackFrame[] {
        return this.frames
    }

    stepUntil(what: { type: 'breakpoint' } | { type: 'any-line', stopEvent: 'stopOnBreakpoint' | 'stopOnStep' } | { type: 'next-line' } | { type: 'out' }) {
        let until: { type: 'breakpoint' } | { type: 'any-line', stopEvent: 'stopOnBreakpoint' | 'stopOnStep' } | { type: 'next-line', depth: number } | { type: 'out', depth: number }
        switch (what.type) {
            case 'next-line':
            case 'out': {
                until = { type: what.type, depth: this.frames.length }
                break
            }
            default:
                until = what
        }
        while (true) {
            const finished = this.vmStep()
            if (finished) {
                this.onFinished()
                return
            }
            const sme = this.currentSourceMapEntry()
            if (sme !== undefined) {
                switch (sme.type) {
                    case 'statement': {
                        if (sme.firstStatement) {
                            this.frames.push({
                                function: sme.function,
                                path: sme.path,
                                line: sme.line,
                            })
                            this.setContParam(this.frames.length)
                        }

                        this.frames[this.frames.length-1].line = sme.line

                        switch (until.type) {
                            case 'breakpoint': {
                                if (this.hasBreakpoint(sme.path, sme.line)) {
                                    this.sendEvent('stopOnBreakpoint')
                                    return
                                }
                                break
                            }
                            case 'any-line': {
                                this.sendEvent(until.stopEvent)
                                return
                            }
                            case 'next-line': {
                                if (this.frames.length <= until.depth) {
                                    this.sendEvent('stopOnStep')
                                    return
                                }
                                break
                            }
                            case 'out': {
                                if (this.frames.length < until.depth) {
                                    this.sendEvent('stopOnStep')
                                    return
                                }
                                break
                            }
                        }

                        break
                    }
                    case 'return': {
                        this.frames.pop()

                        break
                    }
                    case 'catch': {
                        this.frames = this.frames.slice(0, this.getContParam())

                        break
                    }
                }
            }
        }
    }

    prepareGetMethod(args: GetMethodArgs, debugInfo: DebugInfo) {
        this.startGetMethod(args);
        this.setCodeCells(args.code);
        this.setDebugInfo(debugInfo);
    }

    prepareTransaction(args: RunTransactionArgs, code: Cell, debugInfo: DebugInfo) {
        this.startTransaction(args);
        this.setCodeCells(code);
        this.setDebugInfo(debugInfo);
    }

    start(debug: boolean, stopOnEntry: boolean) {
        if (debug) {
            if (stopOnEntry) {
                this.stepUntil({ type: 'any-line', stopEvent: 'stopOnBreakpoint' });
            } else {
                this.continue();
            }
        } else {
            this.continue();
        }
    }
}
