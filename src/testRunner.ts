import * as vscode from "vscode";
import { spawn } from "child_process";
import { chunksToLinesAsync } from "@rauschma/stringio";
import { TestStepResultStatus, TestCase as TestCaseMessage, StepDefinition, Pickle, StepKeywordType, Envelope, Hook, Feature, Step } from "@cucumber/messages";

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
    private testCaseIndex = new Map<string, TestCaseMessage>();
    private testCasePhase = new Map<string, "before" | "context" | "action" | "outcome">();
    private testCaseStartedToTestCase = new Map<string, TestCaseMessage>();
    private testCaseErrors = new Map<string, number>();

    constructor(private logChannel: vscode.OutputChannel) {}

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
        this.runnerData.clear();
        this.picklesIndex.clear();
        this.testCaseIndex.clear();
        this.testCasePhase.clear();
        this.testCaseStartedToTestCase.clear();
        this.testCaseErrors.clear();

        const itemsOptions = items.map((item) => item.uri!.fsPath + ":" + (item.range!.start.line + 1));

        const debugOptions = debug ? ["--inspect=9230"] : [];
        const cucumberProcess = spawn(`node`, [...debugOptions, "./node_modules/@cucumber/cucumber/bin/cucumber.js", ...itemsOptions, "--format", "message"], {
            cwd: vscode.workspace.workspaceFolders![0].uri.fsPath,
            env: process.env,
        });

        if (debug) {
            for await (const line of chunksToLinesAsync(cucumberProcess.stderr)) {
                if (line.startsWith("Debugger listening on ws://")) {
                    const url = line.substring("Debugger listening on ws://".length);
                    if (url) {
                        vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
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

        for await (const line of chunksToLinesAsync(cucumberProcess.stdout)) {
            const data = line.trim();

            if (!data.startsWith("{")) {
                if (data !== "") {
                    this.logChannel.appendLine(`stdout: ${data}`);
                }
                continue;
            }

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
                const data = this.runnerData.get(this.fixUri(hook.sourceReference.uri!));
                data?.hooks.push(hook);
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
                const { step, feature, stepInScenario, testCase } = this.getStepAndFeatureByTestCaseStartedId(
                    items,
                    testStepFinished.testStepId,
                    testStepFinished.testCaseStartedId
                );
                if (!step || !feature || !stepInScenario || !testCase) {
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

                const stepResult = testStepFinished.testStepResult;

                if (stepResult.status === TestStepResultStatus.UNDEFINED) {
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
                } else if (stepResult.status === TestStepResultStatus.PASSED) {
                    //Convert nanoseconds to milliseconds
                    options.passed(step, stepResult.duration.nanos / 1000000);
                } else if (stepResult.status === TestStepResultStatus.FAILED) {
                    if ((stepResult.message ?? "").startsWith("AssertionError [ERR_ASSERTION]")) {
                        const lines = stepResult.message!.split("\n");
                        const message = lines[0];
                        const expected: string[] = [];
                        const actual: string[] = [];

                        if (lines[1] === "    + expected - actual") {
                            for (let i = 3; i < lines.length; i++) {
                                const line = lines[i].trim();
                                if (line.startsWith("+")) {
                                    expected.push(line.substring(1));
                                } else if (line.startsWith("-")) {
                                    actual.push(line.substring(1));
                                }
                            }

                            options.failed(step, vscode.TestMessage.diff(message, expected.join("\n"), actual.join("\n")), stepResult.duration.nanos / 1000000);
                        } else {
                            options.failed(step, new vscode.TestMessage(message));
                        }
                    } else {
                        const fixedNewLines = stepResult.message?.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") ?? "";
                        const firstRow = fixedNewLines.split("\r\n")[0];
                        const rest = fixedNewLines.substring(firstRow?.length ?? 0);

                        options.failed(step, new vscode.TestMessage(firstRow ?? "Unknown error"));
                        options.appendOutput(
                            rest ?? "",
                            {
                                range: step.range!,
                                uri: step.uri!,
                            },
                            step
                        );
                    }

                    let errorsCount = this.testCaseErrors.get(testCase.id) ?? 0;
                    this.testCaseErrors.set(testCase.id, errorsCount + 1);
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

        return { success: cucumberProcess.exitCode === 0 };
    }
}
