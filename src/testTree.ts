import { TextDecoder } from "util";
import * as vscode from "vscode";
import { parseMarkdown } from "./parser";

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

    public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem, logChannel: vscode.OutputChannel) {
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
    public updateFromContents(controller: vscode.TestController, content: string, item: vscode.TestItem, logChannel: vscode.OutputChannel) {
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
                const id = `${scenario.id}/${range.start.line}`;

                const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
                testData.set(tcase, data);
                tcase.range = range;
                scenario.children.add(tcase);
            },

            onScenario: (range, name, tags) => {
                const parent = ancestors[ancestors.length - 1];
                const data = new TestCase(name, thisGeneration, logChannel);
                const id = `${item.id}/${range.start.line}`;

                const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
                testData.set(tcase, data);
                tcase.range = range;
                tcase.tags = [new vscode.TestTag("runnable")].concat(tags.map((t) => new vscode.TestTag(t.name)));
                parent.children.push(tcase);
            },

            onFeature: (range, name, tags) => {
                //ascend(depth);
                const parent = ancestors[ancestors.length - 1];
                const id = `${item.id}:${range.start.line}`;

                const thead = controller.createTestItem(id, name, item.uri);
                thead.range = range;
                thead.tags = [new vscode.TestTag("runnable")].concat(tags.map((t) => new vscode.TestTag(t.name)));
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

export class TestStep {
    constructor(private readonly name: string, private readonly logChannel: vscode.OutputChannel) {}

    getLabel() {
        return `${this.name}`;
    }
}

export class TestCase {
    constructor(private readonly name: string, public generation: number, private logChannel: vscode.OutputChannel) {}

    getLabel() {
        return `${this.name}`;
    }
}
