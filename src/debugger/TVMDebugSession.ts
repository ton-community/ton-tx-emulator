import { InitializedEvent, Logger, logger, LoggingDebugSession, OutputEvent, StoppedEvent, TerminatedEvent, Thread } from "@vscode/debugadapter";
import { Debuggee, Variable } from "./Debuggee";
import { DebugProtocol } from "@vscode/debugprotocol";
import { basename } from "node:path";
import { TupleItem } from "@ton/core";

export class TVMDebugSession extends LoggingDebugSession {
    static readonly threadID = 1;
    static readonly stackFrameID = 1;
    static readonly localVariablesReference = 1;
    static readonly globalVariablesReference = 2;

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
        this.debuggee.stepOver();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.stepIn();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request | undefined): void {
        this.debuggee.stepOut();
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

        const frames = this.debuggee.stackFrames();

        response.body.totalFrames = frames.length;

        if (args.startFrame ?? 0 >= frames.length) {
            response.body.stackFrames = [];
            this.sendResponse(response);
            return;
        }

        response.body.stackFrames = [];

        for (let i = args.startFrame ?? 0; i < frames.length; i++) {
            const frame = frames[i];
            response.body.stackFrames.push({
                id: i === frames.length - 1 ? TVMDebugSession.stackFrameID : 0,
                name: frame.function,
                line: frame.line,
                column: 0,
                source: {
                    name: basename(frame.path),
                    path: frame.path,
                },
            });
        }

        response.body.stackFrames.reverse();

        this.sendResponse(response);
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        if (args.frameId !== TVMDebugSession.stackFrameID) {
            response.body.scopes = [];
            this.sendResponse(response);
            return;
        }

        const sme = this.debuggee.currentSourceMapEntry();
        if (sme === undefined) {
            response.body.scopes = [];
            this.sendResponse(response);
            return;
        }

        response.body.scopes = [{
            name: 'Locals',
            variablesReference: TVMDebugSession.localVariablesReference,
            expensive: false,
        }, {
            name: 'Globals',
            variablesReference: TVMDebugSession.globalVariablesReference,
            expensive: false,
        }];

        this.sendResponse(response);
    }

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request | undefined): void {
        response.body = response.body || {};

        response.body.variables = [];

        let vars: Variable[] | undefined = undefined;
        if (args.variablesReference === TVMDebugSession.localVariablesReference) {
            vars = this.debuggee.getLocalVariables();
        } else if (args.variablesReference === TVMDebugSession.globalVariablesReference) {
            vars = this.debuggee.getGlobalVariables();
        }

        if (vars === undefined) {
            this.sendResponse(response);
            return;
        }

        for (const v of vars) {
            response.body.variables.push({
                name: v.name,
                value: tupleItemToString(v.value),
                type: v.value.type,
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
