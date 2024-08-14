import EventEmitter from 'node:events';
import { Executor, GetMethodArgs, RunTransactionArgs } from '../executor/Executor';
import { Cell, TupleItem } from '@ton/core';
import { InitializedEvent, Logger, logger, LoggingDebugSession, OutputEvent, StoppedEvent, TerminatedEvent, Thread } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'node:path';

export type SourceMapEntry = {
    path: string;
    line: number;
    variables: string[];
};

export type SourceMap = {
    [k: number]: SourceMapEntry;
};

type Breakpoint = {
    id: number;
    line: number;
    verified: boolean;
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
    frames: string[] = [];
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
        this.stepUntilLine(true);
    }

    step(stopEvent = 'stopOnStep') {
        this.stepUntilLine(false, stopEvent);
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

    stepUntilLine(breakpointsOnly: boolean, stopEvent?: string) {
        while (true) {
            const finished = this.vmStep()
            if (finished) {
                this.onFinished()
                return
            }
            const sme = this.currentSourceMapEntry()
            if (sme !== undefined && (!breakpointsOnly || this.hasBreakpoint(sme.path, sme.line))) {
                if (breakpointsOnly) {
                    this.sendEvent('stopOnBreakpoint')
                } else if (stopEvent !== undefined) {
                    this.sendEvent(stopEvent)
                }
                return
            }
        }
    }

    prepareGetMethod(args: GetMethodArgs, sourceMap: SourceMap) {
        this.startGetMethod(args);
        this.setCodeCells(args.code);
        this.setSourceMap(sourceMap);
    }

    prepareTransaction(args: RunTransactionArgs, code: Cell, sourceMap: SourceMap) {
        this.startTransaction(args);
        this.setCodeCells(code);
        this.setSourceMap(sourceMap);
    }

    start(debug: boolean, stopOnEntry: boolean) {
        if (debug) {
            if (stopOnEntry) {
                this.step('stopOnEntry');
            } else {
                this.continue();
            }
        } else {
            this.continue();
        }
    }
}

export class TVMDebugSession extends LoggingDebugSession {
    static readonly threadID = 1;
    static readonly stackFrameID = 1;
    static readonly variablesReference = 1;

    debuggee: Debuggee;

    constructor(debuggee: Debuggee) {
        super();
        this.debuggee = debuggee;

        this.debuggee.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', TVMDebugSession.threadID));
        });
        this.debuggee.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', TVMDebugSession.threadID));
        });
        this.debuggee.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', TVMDebugSession.threadID));
        });
        this.debuggee.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });
        this.debuggee.on('output', (s: string) => {
            this.sendEvent(new OutputEvent(s + '\n', 'stdout'));
        });
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};

        const b = response.body;

        b.supportsConfigurationDoneRequest = false;
        b.supportsFunctionBreakpoints = false;
        b.supportsConditionalBreakpoints = false;
        b.supportsHitConditionalBreakpoints = false;
        b.supportsEvaluateForHovers = false;
        b.supportsStepBack = false;
        b.supportsSetVariable = false;
        b.supportsRestartFrame = false;
        b.supportsGotoTargetsRequest = false;
        b.supportsStepInTargetsRequest = false;
        b.supportsCompletionsRequest = false;
        b.supportsModulesRequest = false;
        b.supportsRestartRequest = false;
        b.supportsValueFormattingOptions = false;
        b.supportsExceptionInfoRequest = false;
        b.supportTerminateDebuggee = false;
        b.supportSuspendDebuggee = false;
        b.supportsDelayedStackTraceLoading = false;
        b.supportsLoadedSourcesRequest = true;
        b.supportsLogPoints = false;
        b.supportsTerminateThreadsRequest = false;
        b.supportsSetExpression = false;
        b.supportsTerminateRequest = false;
        b.supportsDataBreakpoints = false;
        b.supportsReadMemoryRequest = false;
        b.supportsWriteMemoryRequest = false;
        b.supportsDisassembleRequest = false;
        b.supportsCancelRequest = false;
        b.supportsBreakpointLocationsRequest = true;
        b.supportsClipboardContext = false;
        b.supportsSteppingGranularity = false;
        b.supportsInstructionBreakpoints = false;
        b.supportsExceptionFilterOptions = false;
        b.supportsSingleThreadExecutionRequests = false;

        this.sendResponse(response);

        this.sendEvent(new InitializedEvent());
    }

    protected loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        response.body.sources = this.debuggee.getAvailableSourcePaths().map(v => ({
            path: v,
            name: basename(v),
        }));

        this.sendResponse(response);
    }

    protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        const path = args.source.path;
        if (path === undefined) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'No path',
            });
            return;
        }

        response.body.breakpoints = this.debuggee.getAvailableLines(path).filter(l => l >= args.line && l <= (args.endLine ?? args.line)).map(l => ({
            line: l,
        }));

        this.sendResponse(response);
    }

    protected launchRequest(response: DebugProtocol.LaunchResponse, args: DebugProtocol.LaunchRequestArguments, request?: DebugProtocol.Request | undefined): void {
        logger.setup(Logger.LogLevel.Log);

        this.debuggee.start(!args.noDebug, true);

        this.sendResponse(response);
    }

    protected attachRequest(response: DebugProtocol.AttachResponse, args: DebugProtocol.AttachRequestArguments, request?: DebugProtocol.Request | undefined): void {
        this.launchRequest(response, args, request);
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request | undefined): void {
        const path = args.source.path;
        if (path === undefined) {
            this.sendErrorResponse(response, {
                id: 1001,
                format: 'No path',
            });
            return;
        }

        const breakpoints = args.breakpoints;
        if (breakpoints === undefined) {
            this.sendErrorResponse(response, {
                id: 1002,
                format: 'No breakpoints',
            });
            return;
        }

        this.debuggee.clearBreakpoints(path);

        const bps: DebugProtocol.Breakpoint[] = [];
        for (const bp of breakpoints) {
            const sbp = this.debuggee.setBreakpoint(path, bp.line);
            bps.push({
                id: sbp.id,
                line: sbp.line,
                verified: sbp.verified,
            });
        }

        response.body = {
            breakpoints: bps,
        };
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse, request?: DebugProtocol.Request | undefined): void {
        response.body = {
            threads: [
                new Thread(TVMDebugSession.threadID, 'main'),
            ],
        };
        this.sendResponse(response);
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.continue();
        this.sendResponse(response);
    }

    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.step();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.step();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.step();
        this.sendResponse(response);
    }

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        const sme = this.debuggee.currentSourceMapEntry();
        if (sme === undefined) {
            response.body.stackFrames = [];
            response.body.totalFrames = 0;
            this.sendResponse(response);
            return;
        }

        response.body.totalFrames = 1;

        if (args.startFrame ?? 0 > 0) {
            response.body.stackFrames = [];
            this.sendResponse(response);
            return;
        }

        response.body.stackFrames = [{
            id: TVMDebugSession.stackFrameID,
            name: 'func',
            line: sme.line,
            column: 0,
            source: {
                name: basename(sme.path),
                path: sme.path,
            },
        }];

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        const sme = this.debuggee.currentSourceMapEntry();
        if (sme === undefined) {
            response.body.scopes = [];
            this.sendResponse(response);
            return;
        }

        response.body.scopes = [{
            name: 'Locals',
            variablesReference: TVMDebugSession.variablesReference,
            expensive: false,
        }];

        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        response.body.variables = [];

        const sme = this.debuggee.currentSourceMapEntry();
        if (sme === undefined) {
            this.sendResponse(response);
            return;
        }

        const stack = this.debuggee.getStack();
        for (let i = 0; i < sme.variables.length; i++) {
            response.body.variables.push({
                name: sme.variables[i],
                value: tupleItemToString(stack[i]),
                type: stack[i].type,
                variablesReference: 0,
            });
        }

        response.body.variables.sort((a, b) => (a.name < b.name) ? -1 : (a.name > b.name ? 1 : 0));

        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request | undefined): void {
        if (args.restart) {
            this.sendErrorResponse(response, {
                id: 1003,
                format: 'Cannot restart',
            });
        } else {
            this.sendResponse(response);
        }
    }
}

function tupleItemToString(ti: TupleItem): string {
    switch (ti.type) {
        case 'int':
            return ti.value.toString();
        case 'null':
            return 'null';
        case 'nan':
            return 'NaN';
        case 'cell':
        case 'slice':
        case 'builder':
            return ti.cell.toBoc().toString('base64');
        case 'tuple':
            return `[${ti.items.map(v => tupleItemToString(v)).join(', ')}]`;
    }
}