import { TextDecoder } from "util";
import * as vscode from "vscode";
import { parseMarkdown } from "./parser";
import {
    runCucumber,
    loadConfiguration,
    loadSources,
    loadSupport,
} from "@cucumber/cucumber/api";
import { Cli } from "@cucumber/cucumber";
import { spawn } from "child_process";

const textDecoder = new TextDecoder("utf-8");

export type MarkdownTestData = TestFile | TestHeading | TestCase | TestStep;

export const testData = new WeakMap<vscode.TestItem, MarkdownTestData>();

let generationCounter = 0;

export const getContentFromFilesystem = async (uri: vscode.Uri) => {
    try {
        const rawContent = await vscode.workspace.fs.readFile(uri);
        return textDecoder.decode(rawContent);
    } catch (e) {
        console.warn(`Error providing tests for ${uri.fsPath}`, e);
        return "";
    }
};

export class TestFile {
    public didResolve = false;

    public async updateFromDisk(
        controller: vscode.TestController,
        item: vscode.TestItem,
        logChannel: vscode.OutputChannel
    ) {
        try {
            const content = await getContentFromFilesystem(item.uri!);
            item.error = undefined;
            this.updateFromContents(controller, content, item, logChannel);
        } catch (e) {
            item.error = (e as Error).stack;
        }
    }

    /**
     * Parses the tests from the input text, and updates the tests contained
     * by this file to be those from the text,
     */
    public updateFromContents(
        controller: vscode.TestController,
        content: string,
        item: vscode.TestItem,
        logChannel: vscode.OutputChannel
    ) {
        const ancestors = [{ item, children: [] as vscode.TestItem[] }];
        const thisGeneration = generationCounter++;
        this.didResolve = true;

        const ascend = (depth: number) => {
            while (ancestors.length > depth) {
                const finished = ancestors.pop()!;
                finished.item.children.replace(finished.children);
            }
        };

        parseMarkdown(content, {
            onStep: (range, name) => {
                const parent = ancestors[ancestors.length - 1];
                const scenario = parent.children[parent.children.length - 1];
                const data = new TestStep(name, logChannel);
                const id = `${item.uri}/${scenario.label}/${data.getLabel()}`;

                const tcase = controller.createTestItem(
                    id,
                    data.getLabel(),
                    item.uri
                );
                testData.set(tcase, data);
                tcase.range = range;
                scenario.children.add(tcase);
            },

            onScenario: (range, name) => {
                const parent = ancestors[ancestors.length - 1];
                const data = new TestCase(name, thisGeneration, logChannel);
                const id = `${item.uri}/${data.getLabel()}`;

                const tcase = controller.createTestItem(
                    id,
                    data.getLabel(),
                    item.uri
                );
                testData.set(tcase, data);
                tcase.range = range;
                parent.children.push(tcase);
            },

            onFeature: (range, name) => {
                //ascend(depth);
                const parent = ancestors[ancestors.length - 1];
                const id = `${item.uri}/${name}`;

                const thead = controller.createTestItem(id, name, item.uri);
                thead.range = range;
                testData.set(thead, new TestHeading(thisGeneration));
                parent.children.push(thead);
                ancestors.push({ item: thead, children: [] });
            },
        });

        ascend(0); // finish and assign children for all remaining items
    }
}

export class TestHeading {
    constructor(public generation: number) {}
}

type Operator = "+" | "-" | "*" | "/";

export class TestStep {
    constructor(
        private readonly name: string,
        private readonly logChannel: vscode.OutputChannel
    ) {}

    getLabel() {
        return `${this.name}`;
    }
}

type CucumberOutput = {
    status: "passed" | "failed";
    name: string;
    file: string;
    line: number;
    failureMessage?: string;
    expected?: string[];
    actual?: string[];
};

function parseCucumberOutput(output: string) {
    const results: CucumberOutput[] = [];

    const lines = output.split("\n");
    const matchRegex = /^\s*(.) (.*) # (.*):(\d*)$/;

    lines.forEach((line) => {
        let scenario: CucumberOutput | undefined = undefined;
        const match = line.match(matchRegex);
        if (!match) {
            return;
        }

        const checkSymbol = match[1];
        const name = match[2];
        const file = match[3];
        const lineInFile = match[4];

        if (checkSymbol === "√") {
            scenario = {
                status: "passed",
                name: name,
                file: file,
                line: parseInt(lineInFile),
            };
        } else if (checkSymbol === "×") {
            scenario = {
                status: "failed",
                name: name,
                file: file,
                line: parseInt(lineInFile),
                expected: [],
                actual: [],
            };

            let failureMessage = "";
            let i = lines.indexOf(line) + 1;

            if (lines[i].includes("AssertionError [ERR_ASSERTION]")) {
                while (i < lines.length && lines[i].startsWith(" ")) {
                    failureMessage += lines[i].trim() + "\n";
                    i++;
                }
                scenario.failureMessage = failureMessage.trim();

                while (i < lines.length) {
                    if (lines[i].trim().startsWith("+")) {
                        scenario.expected!.push(lines[i].trim().substring(1));
                    } else if (lines[i].trim().startsWith("-")) {
                        scenario.actual!.push(lines[i].trim().substring(1));
                    }
                    i++;
                }
            } else {
                while (i < lines.length && lines[i].startsWith("       ")) {
                    failureMessage += lines[i].trim() + "\n";
                    i++;
                }
                scenario.failureMessage = failureMessage.trim();
            }
        }

        if (scenario?.status) {
            results.push(scenario);
        }
    });

    return results;
}

export class TestCase {
    constructor(
        private readonly name: string,
        public generation: number,
        private logChannel: vscode.OutputChannel
    ) {}

    getLabel() {
        return `${this.name}`;
    }

    async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
        const start = Date.now();
        const failures: CucumberOutput[] = [];
        const failureMessages: string[] = [];

        try {
            const result = await new Promise<{ success: boolean }>(
                (resolve, reject) => {
                    let parseFailures = false;

                    this.logChannel.appendLine(
                        `current path ${
                            vscode.workspace.workspaceFolders![0].uri.fsPath
                        }`
                    );
                    this.logChannel.appendLine(
                        `running node_modules/.bin/cucumber-js.cmd --name "^${
                            item.label
                        }$" ${item.uri!.fsPath}`
                    );

                    const cucumberProcess = spawn(
                        `node`,
                        [
                            "./node_modules/@cucumber/cucumber/bin/cucumber.js",
                            "--name",
                            item.label,
                            item.uri!.fsPath,
                        ],
                        {
                            cwd: vscode.workspace.workspaceFolders![0].uri
                                .fsPath,
                            env: process.env,
                        }
                    );
                    cucumberProcess.stdout.on("data", (dataBuffer: Buffer) => {
                        const data = dataBuffer.toString();

                        if (data.startsWith("Failures:")) {
                            parseFailures = true;
                        } else if (parseFailures) {
                            const parsed = parseCucumberOutput(data);
                            failures.push(...parsed);
                            failureMessages.push(data);
                        }

                        this.logChannel.appendLine(`stdout: ${data}`);
                    });
                    cucumberProcess.stderr.on("data", (data) => {
                        this.logChannel.appendLine(`stderr: ${data}`);
                    });
                    cucumberProcess.on("close", (code) => {
                        this.logChannel.appendLine("cucumber-js terminated");
                        resolve({ success: code === 0 });
                    });
                }
            );

            const duration = Date.now() - start;

            if (result.success) {
                options.passed(item, duration);
                item.children.forEach((child) =>
                    options.passed(child, duration)
                );
            } else {
                const msg = new vscode.TestMessage(failureMessages[0]);
                msg.location = new vscode.Location(item.uri!, item.range!);
                options.failed(item, msg, duration);

                item.children.forEach((child) => {
                    const failure = failures.filter(
                        (f) => f.name === child.label
                    )[0];
                    if (!failure) {
                        options.skipped(child);
                        return;
                    }

                    if (failure && failure.status === "passed") {
                        options.passed(child, duration);
                    } else {
                        options.failed(
                            child,
                            (failure.expected ?? []).length === 0 &&
                                (failure.actual ?? []).length === 0
                                ? new vscode.TestMessage(
                                      failure.failureMessage ?? "Generic Error"
                                  )
                                : vscode.TestMessage.diff(
                                      failure?.failureMessage ??
                                          "Generic error",
                                      (failure?.expected ?? []).join("\n"),
                                      (failure?.actual ?? []).join("\n")
                                  )
                        );
                    }
                });
            }
        } catch (e: any) {
            const duration = Date.now() - start;

            const msg = vscode.TestMessage.diff(e.toString(), "A", "A");
            msg.location = new vscode.Location(item.uri!, item.range!);
            options.failed(item, msg, duration);
        }

        /*const task = new vscode.Task(
			{ type: 'cucumberjs', task: 'test' },
			vscode.workspace.workspaceFolders![0],
			'runCucumberTest',
			'npx',
			new vscode.ShellExecution(`npx cucumber-js ${this.file}:${this.line}`)
		);*/

        /*const start = Date.now();
		await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
		const actual = this.evaluate();
		const duration = Date.now() - start;

		if (actual === this.expected) {
			options.passed(item, duration);
		} else {
			const message = vscode.TestMessage.diff(`Expected ${item.label}`, String(this.expected), String(actual));
			message.location = new vscode.Location(item.uri!, item.range!);
			options.failed(item, message, duration);
		}*/
    }

    private evaluate() {
        /*switch (this.operator) {
			case '-':
				return this.a - this.b;
			case '+':
				return this.a + this.b;
			case '/':
				return Math.floor(this.a / this.b);
			case '*':
				return this.a * this.b;
		}*/
    }
}
