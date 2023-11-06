import * as vscode from "vscode";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { chunksToLinesAsync } from "@rauschma/stringio";
import { TestStepResultStatus, TestCase as TestCaseMessage, StepDefinition, Pickle, StepKeywordType, Envelope, Hook, Feature, Step, TestStepFinished } from "@cucumber/messages";
import { handleError } from "./errorHandlers/testRunErrorHandler";
import path = require("path");
import { Readable } from "stream";

type RunnerData = {
    uri: string;
    feature: Feature;
    pickles: Pickle[];
    stepDefinitions: StepDefinition[];
    hooks: Hook[];
    testCases: TestCaseMessage[];
};

export class TestRunner {
    private runnerData = new Map<string, RunnerData>();
    private picklesIndex = new Map<string, Pickle>();
    private hooksIndex = new Map<string, Hook>();
    private testCaseIndex = new Map<string, TestCaseMessage>();
    private testCasePhase = new Map<string, "before" | "context" | "action" | "outcome">();
    private testCaseStartedToTestCase = new Map<string, TestCaseMessage>();
    private testCaseErrors = new Map<string, number>();

    constructor(private logChannel: vscode.OutputChannel, private diagnosticCollection: vscode.DiagnosticCollection) {}

    private tryParseJson<T>(inputString: string): T | null {
        try {
            return JSON.parse(inputString);
        } catch (e) {
            return null;
        }
    }

    private getStepAndFeatureByTestCaseStartedId(
        items: vscode.TestItem[],
        stepId: string,
        testCaseStartedId: string
    ): { step?: vscode.TestItem; feature?: vscode.TestItem; testCase?: TestCaseMessage; stepInScenario?: Step } {
        const testCase = this.testCaseStartedToTestCase.get(testCaseStartedId);
        if (!testCase) {
            return {};
        }

        const pickle = this.picklesIndex.get(testCase!.pickleId)!;
        if (!pickle) {
            return {};
        }

        //Find step in testCase
        const testStep = testCase?.testSteps.find((s) => s.id === stepId);
        if (!testStep) {
            return {};
        }

        //Find step in pickle
        const pickleStep = pickle.steps.find((s) => s.id === testStep.pickleStepId);
        if (!pickleStep) {
            return {};
        }

        const stepAstId = pickleStep.astNodeIds[0];

        //Find step in gherkinDocument
        const data = this.runnerData.get(this.fixUri(pickle.uri!));
        if (!data) {
            return {};
        }

        const scenario = data.feature.children.find((scenario) => {
            if (!scenario.scenario) {
                return false;
            }
            return scenario.scenario.steps.some((step) => step.id === stepAstId);
        });
        if (!scenario) {
            return {};
        }

        const stepInScenario = scenario.scenario!.steps.find((step) => step.id === stepAstId);
        if (!stepInScenario) {
            return {};
        }

        const featureExpectedId = `${data!.uri}/${scenario.scenario!.location.line - 1}`;
        const stepExpectedId = `${featureExpectedId}/${stepInScenario.location.line - 1}`;
        const feature = items.find((item) => item.id === featureExpectedId);
        if (!feature) {
            return {};
        }

        const step = feature.children.get(stepExpectedId);
        if (!step) {
            return {};
        }

        return {
            step,
            feature,
            testCase,
            stepInScenario,
        };
    }

    private getHandleHookStepFinished(items: vscode.TestItem[], stepFinished: TestStepFinished) {
        const testCase = this.testCaseStartedToTestCase.get(stepFinished.testCaseStartedId);
        if (!testCase) {
            return {};
        }

        const pickle = this.picklesIndex.get(testCase!.pickleId)!;
        if (!pickle) {
            return {};
        }

        //Find step in testCase
        const testStep = testCase?.testSteps.find((s) => s.id === stepFinished.testStepId);
        if (!testStep) {
            return {};
        }

        //Find hook by id
        const hook = this.hooksIndex.get(testStep.hookId!);
        if (!hook) {
            return {};
        }

        const data = this.runnerData.get(this.fixUri(pickle.uri!));
        if (!data) {
            return {};
        }

        const stepAstId = pickle.astNodeIds[0];

        const scenario = data.feature.children.find((scenario) => {
            if (!scenario.scenario) {
                return false;
            }
            return scenario.scenario.id === stepAstId;
        });
        if (!scenario) {
            return {};
        }

        const featureExpectedId = `${data!.uri}/${scenario.scenario!.location.line - 1}`;
        const feature = items.find((item) => item.id === featureExpectedId);
        if (!feature) {
            return {};
        }

        return {
            feature,
            testCase,
            hook,
        };
    }

    private fixUri(uri: string) {
        return uri.replace(/\\/g, "/");
    }

    private *flattenHierarchyCollection(items: vscode.TestItemCollection): Generator<vscode.TestItem> {
        for (const item of items) {
            yield item[1];
            yield* this.flattenHierarchyCollection(item[1].children);
        }
    }

    private *flattenHierarchy(items: vscode.TestItem[]): Generator<vscode.TestItem> {
        for (const item of items) {
            yield item;
            yield* this.flattenHierarchyCollection(item.children);
        }
    }

    async run(items: vscode.TestItem[], options: vscode.TestRun, debug: boolean) {
        this.clearPreviousTestResult();

        const workspace = vscode.workspace.workspaceFolders![0];

        const itemsOptions = items.map((item) => item.uri!.fsPath + ":" + (item.range!.start.line + 1));
        const adapterConfig = vscode.workspace.getConfiguration("cucumberTestRunner", workspace.uri);
        const env = this.getEnvironmentVariables(adapterConfig);

        const cwd = this.getRunnerWorkingDirectory(workspace, adapterConfig);
        this.logChannel.appendLine(`Working Directory: ${cwd}`);

        const profileOptions = this.getProfileOptions(adapterConfig);

        const debugOptions = debug ? ["--inspect-brk=9229"] : [];

        const cucumberProcess = spawn(
            `node`,
            [...debugOptions, `${workspace.uri.fsPath}/node_modules/@cucumber/cucumber/bin/cucumber.js`, ...itemsOptions, "--format", "message", ...profileOptions],
            {
                cwd,
                env,
            }
        );

        this.logChannel.appendLine(`Started Process ${cucumberProcess.spawnfile}:    ${cucumberProcess.spawnargs}`);

        if (debug) {
            await this.startDebuggingProcess(cucumberProcess, workspace);
        }

        await Promise.all([this.logStdOutPipe(cucumberProcess.stdout, items, options, workspace), this.logStdErrPipe(cucumberProcess.stderr, items, options)]);

        this.logChannel.appendLine(`Process exited with code ${cucumberProcess.exitCode}`);

        return { success: cucumberProcess.exitCode === 0 };
    }

    private clearPreviousTestResult() {
        this.runnerData.clear();
        this.picklesIndex.clear();
        this.hooksIndex.clear();
        this.testCaseIndex.clear();
        this.testCasePhase.clear();
        this.testCaseStartedToTestCase.clear();
        this.testCaseErrors.clear();
    }

    private async logStdErrPipe(pipe: Readable, items: vscode.TestItem[], options: vscode.TestRun) {
        const stdErrorLines = await this.readLogsFromStdErr(pipe);
        const errorMessages = this.createErrorMessagesFromStdErrorOutput(stdErrorLines);

        for (const item of items) {
            options.errored(item, errorMessages);
        }
    }

    private async readLogsFromStdErr(pipe: Readable): Promise<string[]> {
        const pipeName = "stderr";
        const errorMessages = [];

        for await (const line of chunksToLinesAsync(pipe)) {
            const trimmedLine = line.trim();
            this.logChannel.appendLine(`${pipeName}: ${trimmedLine}`);
            errorMessages.push(trimmedLine);
        }

        return errorMessages;
    }

    createErrorMessagesFromStdErrorOutput(stdErrorLines: string[]): vscode.TestMessage[] {
        const message = stdErrorLines.join("\n");
        // Replace the first line with whitespace, as the first line starts only with "Error: " and, thus, no proper error message is displayed in feature file.
        const messageWithWhitespace = message.replace("\n", " ");
        
        return [ new vscode.TestMessage(messageWithWhitespace) ];
    }

    private async logStdOutPipe(pipe: Readable, items: vscode.TestItem[], options: vscode.TestRun, workspace: vscode.WorkspaceFolder) {
        const pipeName = "stdout";
        for await (const line of chunksToLinesAsync(pipe)) {
            const data = line.trim();

            if (!data.startsWith("{")) {
                if (data !== "") {
                    this.logChannel.appendLine(`${pipeName}: ${data}`);
                    vscode.debug.activeDebugConsole.appendLine(data);
                }
                continue;
            }
            this.logChannel.appendLine(`${pipeName}: ${data}`);

            const objectData = this.tryParseJson<Envelope>(data);
            if (!objectData) {
                continue;
            }
            if (typeof objectData !== "object") {
                continue;
            }

            if (objectData.gherkinDocument) {
                this.runnerData.set(this.fixUri(objectData.gherkinDocument.uri!), {
                    uri: this.fixUri(objectData.gherkinDocument.uri!),
                    feature: objectData.gherkinDocument.feature!,
                    pickles: [],
                    stepDefinitions: [],
                    hooks: [],
                    testCases: [],
                });
            }

            if (objectData.pickle) {
                const pickle = objectData.pickle;
                const data = this.runnerData.get(this.fixUri(pickle.uri));
                data?.pickles.push(pickle);
                this.picklesIndex.set(pickle.id, pickle);
            }

            if (objectData.stepDefinition) {
                const stepDefinition = objectData.stepDefinition;
                const data = this.runnerData.get(this.fixUri(stepDefinition.sourceReference.uri!));
                data?.stepDefinitions.push(stepDefinition);
            }

            if (objectData.hook) {
                const hook = objectData.hook;
                this.hooksIndex.set(hook.id, hook);
            }

            if (objectData.testRunStarted) {
                for (const item of this.flattenHierarchy(items)) {
                    options.started(item);
                }
            }

            if (objectData.testCase) {
                const testCase = objectData.testCase;
                const pickle = this.picklesIndex.get(testCase.pickleId)!;
                const data = this.runnerData.get(this.fixUri(pickle.uri!));
                data?.testCases.push(testCase);
                this.testCaseIndex.set(testCase.id, testCase);
                this.testCasePhase.set(testCase.id, "before");
            }

            if (objectData.testCaseStarted) {
                //Nothing to do
                const testCase = this.testCaseIndex.get(objectData.testCaseStarted.testCaseId)!;
                this.testCaseStartedToTestCase.set(objectData.testCaseStarted.id, testCase);
            }

            if (objectData.testStepStarted) {
                //Nothing to do
            }

            if (objectData.testStepFinished) {
                const testStepFinished = objectData.testStepFinished;
                const stepResult = testStepFinished.testStepResult;

                const { step, feature, stepInScenario, testCase } = this.getStepAndFeatureByTestCaseStartedId(
                    items,
                    testStepFinished.testStepId,
                    testStepFinished.testCaseStartedId
                );
                if (!step || !feature || !stepInScenario || !testCase) {
                    const { feature, testCase, hook } = this.getHandleHookStepFinished(items, testStepFinished);
                    if (!feature || !testCase || !hook) {
                        continue;
                    }

                    // Don't send errors for passed steps!
                    if (stepResult.status === TestStepResultStatus.PASSED) {
                        continue;
                    }

                    const range = new vscode.Range(hook.sourceReference.location!.line, hook.sourceReference.location?.column ?? 0, hook.sourceReference.location!.line, 100);
                    const fullUri = workspace.uri.toString() + "/" + this.fixUri(hook.sourceReference.uri!);
                    handleError(stepResult, feature, fullUri, range, options, this.diagnosticCollection);

                    let errorsCount = this.testCaseErrors.get(testCase.id) ?? 0;
                    this.testCaseErrors.set(testCase.id, errorsCount + 1);
                    continue;
                }

                let phase = this.testCasePhase.get(testCase.id)!;
                switch (stepInScenario.keywordType) {
                    case StepKeywordType.CONTEXT:
                        phase = "context";
                        this.testCasePhase.set(testCase.id, phase);
                        break;
                    case StepKeywordType.ACTION:
                        phase = "action";
                        this.testCasePhase.set(testCase.id, phase);
                        break;
                    case StepKeywordType.OUTCOME:
                        phase = "outcome";
                        this.testCasePhase.set(testCase.id, phase);
                        break;
                }

                switch (stepResult.status) {
                    case TestStepResultStatus.UNDEFINED:
                        {
                            const msg = new vscode.TestMessage("Undefined. Implement with the following snippet:\n\n");

                            if (stepInScenario.keywordType === StepKeywordType.CONTEXT || (stepInScenario.keywordType === StepKeywordType.CONJUNCTION && phase === "context")) {
                                msg.message += `Given('${stepInScenario.text}', function () {\n  return 'pending';\n});`;
                            }
                            if (stepInScenario.keywordType === StepKeywordType.ACTION || (stepInScenario.keywordType === StepKeywordType.CONJUNCTION && phase === "action")) {
                                msg.message += `When('${stepInScenario.text}', function () {\n  return 'pending';\n});`;
                            }
                            if (stepInScenario.keywordType === StepKeywordType.OUTCOME || (stepInScenario.keywordType === StepKeywordType.CONJUNCTION && phase === "outcome")) {
                                msg.message += `Then('${stepInScenario.text}', function () {\n  return 'pending';\n});`;
                            }

                            options.errored(step, msg, stepResult.duration.nanos / 1000000);

                            let errorsCount = this.testCaseErrors.get(testCase.id) ?? 0;
                            this.testCaseErrors.set(testCase.id, errorsCount + 1);
                        }
                        break;
                    case TestStepResultStatus.PASSED:
                        {
                            //Convert nanoseconds to milliseconds
                            options.passed(step, stepResult.duration.nanos / 1000000);
                        }
                        break;
                    case TestStepResultStatus.FAILED:
                        {
                            handleError(stepResult, step, step.uri!.toString(), step.range!, options, this.diagnosticCollection);

                            let errorsCount = this.testCaseErrors.get(testCase.id) ?? 0;
                            this.testCaseErrors.set(testCase.id, errorsCount + 1);
                        }
                        break;
                    case TestStepResultStatus.SKIPPED:
                        {
                            options.skipped(step);
                        }
                        break;
                    default:
                        throw new Error(`Unhandled step result: ${stepResult.status}`);
                }
            }

            if (objectData.testCaseFinished) {
                const testCaseFinished = objectData.testCaseFinished;
                const testCase = this.testCaseStartedToTestCase.get(testCaseFinished.testCaseStartedId);
                if (!testCase) {
                    continue;
                }

                const pickle = this.picklesIndex.get(testCase.pickleId);
                if (!pickle) {
                    continue;
                }

                const data = this.runnerData.get(this.fixUri(pickle.uri!));
                if (!data) {
                    continue;
                }

                const scenarioId = pickle.astNodeIds[0];
                const scenario = data.feature.children.find((c) => {
                    if (!c.scenario) {
                        return false;
                    }
                    return c.scenario.id === scenarioId;
                });
                if (!scenario || !scenario.scenario) {
                    continue;
                }

                const featureExpectedId = `${data!.uri}/${scenario.scenario.location.line}`;
                const feature = items.find((i) => i.id === featureExpectedId);
                if (!feature) {
                    continue;
                }

                const errors = this.testCaseErrors.get(testCase.id) ?? 0;
                if (errors > 0) {
                    options.failed(feature, new vscode.TestMessage("One or more steps failed"));
                } else {
                    options.passed(feature);
                }

                options.end();
            }
        }
    }

    private async startDebuggingProcess(cucumberProcess: ChildProcessWithoutNullStreams, workspace: vscode.WorkspaceFolder) {
        for await (const line of chunksToLinesAsync(cucumberProcess.stderr)) {
            if (line.startsWith("Debugger listening on ws://")) {
                const url = line.substring("Debugger listening on ws://".length);
                if (url) {
                    vscode.debug.startDebugging(workspace, {
                        type: "node",
                        request: "attach",
                        name: "Attach to Cucumber",
                        address: url,
                        localRoot: "${workspaceFolder}",
                        remoteRoot: "${workspaceFolder}",
                        protocol: "inspector",
                        port: 9230,
                        skipFiles: ["<node_internals>/**"],
                    });
                }
                break;
            }
        }
    }

    private getEnvironmentVariables(adapterConfig: vscode.WorkspaceConfiguration) {
        const processEnv = process.env;

        const configEnv = adapterConfig.get<{ [prop: string]: any }>("env") ?? {};
        const env = { ...processEnv };
        for (const prop in configEnv) {
            const val = configEnv[prop];
            if (val === undefined || val === null) {
                delete env[prop];
            } else {
                env[prop] = String(val);
            }
        }
        return env;
    }

    private getProfileOptions(adapterConfig: vscode.WorkspaceConfiguration) {
        const profile = adapterConfig.get<string>("profile");
        const profileOptions = profile !== undefined && profile !== "" ? ["--profile", profile] : [];
        return profileOptions;
    }

    private getRunnerWorkingDirectory(workspace: vscode.WorkspaceFolder, settings: vscode.WorkspaceConfiguration) {
        const cwd = settings.get<string | undefined>("cwd");
        return cwd ? path.normalize(path.join(workspace.uri.fsPath, cwd)) : workspace.uri.fsPath;
    }
}
