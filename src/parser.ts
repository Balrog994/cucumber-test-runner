import * as vscode from "vscode";
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";

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

    const featureRange = new vscode.Range(document.feature.location.line - 1, (document.feature.location.column ?? 1) - 1, document.feature.location.line - 1, 100);
    events.onFeature(featureRange, document.feature.name);

    for (const child of document.feature.children) {
        if (child.scenario) {
            const scenarioRange = new vscode.Range(child.scenario.location.line - 1, (child.scenario.location.column ?? 1) - 1, child.scenario.location.line - 1, 100);
            events.onScenario(scenarioRange, child.scenario.name);

            for (const step of child.scenario.steps) {
                const stepRange = new vscode.Range(step.location.line - 1, (step.location.column ?? 1) - 1, step.location.line - 1, 100);
                events.onStep(stepRange, step.keyword + step.text);
            }
        }
    }
};
