import { TestStepResult } from "@cucumber/messages";
import * as vscode from "vscode";
import DefaultErrorHandler from "./defaultErrorHandler";

export interface ITestRunErrorHandler {
    canHandleError(result: TestStepResult): boolean;
    handleError(result: TestStepResult, step: vscode.TestItem, uri: string, range: vscode.Range, options: vscode.TestRun, diagnosticCollection: vscode.DiagnosticCollection): void;
}

const handlers = new Array<ITestRunErrorHandler>();
const defaultHandler = new DefaultErrorHandler();

export const registerHandler = (handler: ITestRunErrorHandler) => handlers.push(handler);
export const handleError = (
    result: TestStepResult,
    step: vscode.TestItem,
    uri: string,
    range: vscode.Range,
    options: vscode.TestRun,
    diagnosticCollection: vscode.DiagnosticCollection
) => {
    const validHandler = handlers.find((f) => f.canHandleError(result)) ?? defaultHandler;
    validHandler.handleError(result, step, uri, range, options, diagnosticCollection);
};
