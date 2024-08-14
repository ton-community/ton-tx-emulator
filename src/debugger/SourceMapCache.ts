import { SourceMap } from "./Debuggee";
import { CompileResult } from '@ton/blueprint';
import { resolve } from 'node:path';

export type SourceMapCache = Map<string, SourceMap>;

export const defaultSourceMapCache: SourceMapCache = new Map();

export function registerCompiledContract(c: CompileResult) {
    if (c.lang !== 'func') {
        throw new Error('Can only register func contracts');
    }

    if (c.debugInfo === undefined) {
        throw new Error('No debug info');
    }

    const sm: SourceMap = {};

    for (let i = 0; i < c.debugInfo.length; i++) {
        const di = c.debugInfo[i];
        if (di.ret || di.vars === undefined) continue;
        sm[i] = {
            path: resolve(di.file),
            line: di.line,
            variables: di.vars ?? [],
        };
    }

    defaultSourceMapCache.set(c.code.hash().toString('base64'), sm);

    return c.code;
}
