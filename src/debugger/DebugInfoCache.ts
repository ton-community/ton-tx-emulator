import { DebugInfo, SourceMap } from "./Debuggee";
import { CompileResult } from '@ton/blueprint';
import { resolve } from 'node:path';

export type DebugInfoCache = Map<string, DebugInfo>;

export const defaultDebugInfoCache: DebugInfoCache = new Map();

export function registerCompiledContract(c: CompileResult) {
    if (c.lang !== 'func') {
        throw new Error('Can only register func contracts');
    }

    if (c.debugInfo === undefined) {
        throw new Error('No debug info');
    }

    const { locations, globals } = c.debugInfo;

    const sm: SourceMap = {};

    for (let i = 0; i < locations.length; i++) {
        const di = locations[i];
        const common = {
            path: resolve(di.file),
            line: di.line,
            function: di.func,
        };
        if (di.ret) {
            sm[i] = {
                ...common,
                type: 'return',
            };
        } else if (di.is_catch) {
            sm[i] = {
                ...common,
                type: 'catch',
            };
        } else {
            sm[i] = {
                ...common,
                type: 'statement',
                variables: di.vars ?? [],
                firstStatement: di.first_stmt,
            };
        }
    }

    defaultDebugInfoCache.set(c.code.hash().toString('base64'), {
        sourceMap: sm,
        globals,
    });

    return c.code;
}
