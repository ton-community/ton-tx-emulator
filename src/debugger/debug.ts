import { Cell } from '@ton/core';
import { GetMethodArgs, Executor, GetMethodResult, RunTransactionArgs, EmulationResult } from '../executor/Executor';
import { Debuggee, DebugInfo } from "./Debuggee";
import * as Net from 'net';
import { TVMDebugSession } from './TVMDebugSession';

function initDebuggee(executor: Executor) {
    let dbg: Debuggee = null as any;
    const promise = new Promise((resolve) => {
        dbg = new Debuggee(executor, resolve);
    });
    return { dbg, promise };
}

export async function debugGetMethod(executor: Executor, args: GetMethodArgs, debugInfo: DebugInfo): Promise<GetMethodResult> {
    console.log('Launched get method debug session. Please connect using the extension.');

    const { dbg, promise } = initDebuggee(executor);
    dbg.prepareGetMethod(args, debugInfo);
    const server = Net.createServer((socket) => {
        const session = new TVMDebugSession(dbg);
        session.setRunAsServer(true);
        session.start(socket, socket);
    }).listen(42069);
    const result = await promise;
    server.close();
    return result as GetMethodResult;
}

export async function debugTransaction(executor: Executor, args: RunTransactionArgs, code: Cell, debugInfo: DebugInfo) {
    console.log('Launched transaction debug session. Please connect using the extension.');

    const { dbg, promise } = initDebuggee(executor);
    dbg.prepareTransaction(args, code, debugInfo);
    const server = Net.createServer((socket) => {
        const session = new TVMDebugSession(dbg);
        session.setRunAsServer(true);
        session.start(socket, socket);
    }).listen(42069);
    const result = await promise;
    server.close();
    return result as EmulationResult;
}
