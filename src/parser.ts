import * as vscode from "vscode";
import {
    AstBuilder,
    GherkinClassicTokenMatcher,
    Parser,
} from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";

const testRe = /^([0-9]+)\s*([+*/-])\s*([0-9]+)\s*=\s*([0-9]+)/;
const headingRe = /^(#+)\s*(.+)$/;

export const parseMarkdown = (
    text: string,
    events: {
        onStep(range: vscode.Range, name: string): void;
        onScenario(range: vscode.Range, name: string): void;
        onFeature(range: vscode.Range, name: string): void;
    }
) => {
    const uuidFn = IdGenerator.uuid();
    const builder = new AstBuilder(uuidFn);
    const matcher = new GherkinClassicTokenMatcher();
    const parser = new Parser(builder, matcher);
    const document = parser.parse(text);

    if (!document.feature) {
        return;
    }

    const featureRange = new vscode.Range(
        document.feature.location.line - 1,
        (document.feature.location.column ?? 1) - 1,
        document.feature.location.line - 1,
        100
    );
    events.onFeature(featureRange, document.feature.name);

    for (const child of document.feature.children) {
        if (child.scenario) {
            const scenarioRange = new vscode.Range(
                child.scenario.location.line - 1,
                (child.scenario.location.column ?? 1) - 1,
                child.scenario.location.line - 1,
                100
            );
            events.onScenario(scenarioRange, child.scenario.name);

            for (const step of child.scenario.steps) {
                const stepRange = new vscode.Range(
                    step.location.line - 1,
                    (step.location.column ?? 1) - 1,
                    step.location.line - 1,
                    100
                );
                events.onStep(stepRange, step.keyword + step.text);
            }
        }
    }

    /*const lines = text.split('\n');

	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo];
		const test = testRe.exec(line);
		if (test) {
			const [, a, operator, b, expected] = test;
			const range = new vscode.Range(new vscode.Position(lineNo, 0), new vscode.Position(lineNo, test[0].length));
			events.onTest(range, Number(a), operator, Number(b), Number(expected));
			continue;
		}

		const heading = headingRe.exec(line);
		if (heading) {
			const [, pounds, name] = heading;
			const range = new vscode.Range(new vscode.Position(lineNo, 0), new vscode.Position(lineNo, line.length));
			events.onHeading(range, name, pounds.length);
		}
	}*/
};
