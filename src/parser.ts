import * as vscode from "vscode";
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import { Feature, FeatureChild, IdGenerator, Rule, RuleChild, Scenario, Tag } from "@cucumber/messages";

type ParserEvents = {
    onStep(range: vscode.Range, name: string, tags: readonly Tag[]): void;
    onScenario(range: vscode.Range, name: string, tags: readonly Tag[]): void;
    onFeature(range: vscode.Range, name: string, tags: readonly Tag[]): void;
};

const parseChild = (child: FeatureChild & RuleChild, events: ParserEvents, lineOverride?: number) => {
    if (child.scenario) {
        parseScenario(child.scenario, events, lineOverride);
    } else if (child.rule) {
        parseRule(child.rule, events);
    } else if (child.background) {
        //Ignore background
    }
};

const parseFeature = (feature: Feature, events: ParserEvents) => {
    const featureRange = new vscode.Range(feature.location.line - 1, (feature.location.column ?? 1) - 1, feature.location.line - 1, 100);
    events.onFeature(featureRange, feature.name, feature.tags);

    for (const child of feature.children) {
        parseChild(child, events);
    }
};

const parseScenario = (scenario: Scenario, events: ParserEvents, lineOverride?: number) => {
    const line = lineOverride ?? scenario.location.line;

    const scenarioRange = new vscode.Range(line - 1, (scenario.location.column ?? 1) - 1, line - 1, 100);
    events.onScenario(scenarioRange, scenario.name, scenario.tags);

    for (const step of scenario.steps) {
        const stepRange = new vscode.Range(step.location.line - 1, (step.location.column ?? 1) - 1, step.location.line - 1, 100);
        events.onStep(stepRange, step.keyword + step.text, scenario.tags);
    }
};

const parseRule = (rule: Rule, events: ParserEvents) => {
    for (const child of rule.children) {
        parseChild(child, events, rule.location.line);
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
