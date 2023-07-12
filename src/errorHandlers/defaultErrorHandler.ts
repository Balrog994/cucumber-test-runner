import * as vscode from "vscode";
import { TestStepResult } from "@cucumber/messages";
import { TestItem, TestRun } from "vscode";
import type { ITestRunErrorHandler } from "./testRunErrorHandler";

export default class DefaultErrorHandler implements ITestRunErrorHandler {
    canHandleError(result: TestStepResult): boolean {
        return true;
    }

    handleError(result: TestStepResult, step: TestItem, uri: string, range: vscode.Range, options: TestRun, diagnosticCollection: vscode.DiagnosticCollection): void {
        const fixedNewLines = result.message?.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") ?? "";
        const firstRow = fixedNewLines.split("\r\n")[0];
        const rest = fixedNewLines.substring(firstRow?.length ?? 0);

        options.failed(step, new vscode.TestMessage(firstRow ?? "Unknown error"));

        const fullUri = vscode.Uri.parse(uri);

        const newErrors = [...(diagnosticCollection.get(fullUri) ?? [])];
        newErrors.push(new vscode.Diagnostic(range, fixedNewLines, vscode.DiagnosticSeverity.Error));

        diagnosticCollection.set(vscode.Uri.parse(uri), newErrors);
    }
}
