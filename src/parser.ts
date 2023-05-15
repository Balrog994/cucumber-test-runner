import * as vscode from "vscode";
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { Feature, FeatureChild, IdGenerator, Rule, RuleChild, Scenario } from "@cucumber/messages";

type ParserEvents = {
    onStep(range: vscode.Range, name: string): void;
    onScenario(range: vscode.Range, name: string): void;
    onFeature(range: vscode.Range, name: string): void;
};

const parseChild = (child: FeatureChild & RuleChild, events: ParserEvents) => {
    if (child.scenario) {
        parseScenario(child.scenario, events);
    } else if (child.rule) {
        parseRule(child.rule, events);
    } else if (child.background) {
        //Ignore background
    }
};

const parseFeature = (feature: Feature, events: ParserEvents) => {
    const featureRange = new vscode.Range(feature.location.line - 1, (feature.location.column ?? 1) - 1, feature.location.line - 1, 100);
    events.onFeature(featureRange, feature.name);

    for (const child of feature.children) {
        parseChild(child, events);
    }
};

const parseScenario = (scenario: Scenario, events: ParserEvents) => {
    const scenarioRange = new vscode.Range(scenario.location.line - 1, (scenario.location.column ?? 1) - 1, scenario.location.line - 1, 100);
    events.onScenario(scenarioRange, scenario.name);

    for (const step of scenario.steps) {
        const stepRange = new vscode.Range(step.location.line - 1, (step.location.column ?? 1) - 1, step.location.line - 1, 100);
        events.onStep(stepRange, step.keyword + step.text);
    }
};

const parseRule = (rule: Rule, events: ParserEvents) => {
    for (const child of rule.children) {
        parseChild(child, events);
    }
};

export const parseMarkdown = (text: string, events: ParserEvents) => {
    const uuidFn = IdGenerator.uuid();
    const builder = new AstBuilder(uuidFn);
    const matcher = new GherkinClassicTokenMatcher();
    const parser = new Parser(builder, matcher);
    const document = parser.parse(text);

    if (!document.feature) {
        return;
    }

    parseFeature(document.feature, events);
};
