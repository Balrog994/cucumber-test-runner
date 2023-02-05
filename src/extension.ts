// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import { getContentFromFilesystem, TestCase, testData, TestFile } from "./testTree";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    const ctrl = vscode.tests.createTestController("cucumberTestRunnerTests", "Cucumber Tests");
    context.subscriptions.push(ctrl);

    const channel = vscode.window.createOutputChannel("Cucumber Test Runner");
    context.subscriptions.push(channel);

    const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
    const runHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
        //if (!request.continuous) {
        return startTestRun(request, false);
        //}

        /*const l = fileChangedEmitter.event((uri) =>
            startTestRun(
                new vscode.TestRunRequest(
                    [getOrCreateFile(ctrl, uri).file],
                    undefined,
                    request.profile
                    //true
                )
            )
        );
        cancellation.onCancellationRequested(() => l.dispose());*/
    };

    const debugHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
        return startTestRun(request, true);
    };

    const startTestRun = (request: vscode.TestRunRequest, debug: boolean) => {
        const queue: { test: vscode.TestItem; data: TestCase }[] = [];
        const run = ctrl.createTestRun(request);
        // map of file uris to statements on each line:
        /*const coveredLines = new Map<
            string, // file uri
            (vscode.StatementCoverage | undefined)[]
        >();*/

        const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
            for (const test of tests) {
                if (request.exclude?.includes(test)) {
                    continue;
                }

                const data = testData.get(test);
                if (data instanceof TestCase) {
                    run.enqueued(test);
                    queue.push({ test, data });
                } else {
                    if (data instanceof TestFile && !data.didResolve) {
                        await data.updateFromDisk(ctrl, test, channel);
                    }

                    await discoverTests(gatherTestItems(test.children));
                }

                /*if (test.uri && !coveredLines.has(test.uri.toString())) {
                    try {
                        const lines = (
                            await getContentFromFilesystem(test.uri)
                        ).split("\n");
                        coveredLines.set(
                            test.uri.toString(),
                            lines.map((lineText, lineNo) =>
                                lineText.trim().length
                                    ? new vscode.StatementCoverage(
                                          0,
                                          new vscode.Position(lineNo, 0)
                                      )
                                    : undefined
                            )
                        );
                    } catch {
                        // ignored
                    }
                }*/
            }
        };

        const runTestQueue = async () => {
            for (const { test, data } of queue) {
                run.appendOutput(`Running ${test.id}\r\n`);
                if (run.token.isCancellationRequested) {
                    run.skipped(test);
                } else {
                    run.started(test);
                    await data.runNew(test, run, debug);
                }

                /*const lineNo = test.range!.start.line;
                const fileCoverage = coveredLines.get(test.uri!.toString());
                if (fileCoverage) {
                    fileCoverage[lineNo]!.executionCount++;
                }*/

                run.appendOutput(`Completed ${test.id}\r\n`);
            }

            run.end();
        };

        /*run.coverageProvider = {
            provideFileCoverage() {
                const coverage: vscode.FileCoverage[] = [];
                for (const [uri, statements] of coveredLines) {
                    coverage.push(
                        vscode.FileCoverage.fromDetails(
                            vscode.Uri.parse(uri),
                            statements.filter(
                                (s): s is vscode.StatementCoverage => !!s
                            )
                        )
                    );
                }

                return coverage;
            },
        };*/

        discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(runTestQueue);
    };

    ctrl.refreshHandler = async () => {
        await Promise.all(getWorkspaceTestPatterns().map(({ pattern }) => findInitialFiles(ctrl, pattern)));
    };

    ctrl.createRunProfile(
        "Run Tests",
        vscode.TestRunProfileKind.Run,
        runHandler,
        true,
        undefined
        //true
    );

    ctrl.createRunProfile(
        "Debug Tests",
        vscode.TestRunProfileKind.Debug,
        debugHandler,
        true,
        undefined
        //true
    );

    ctrl.resolveHandler = async (item) => {
        if (!item) {
            context.subscriptions.push(...startWatchingWorkspace(ctrl, fileChangedEmitter, channel));
            return;
        }

        const data = testData.get(item);
        if (data instanceof TestFile) {
            await data.updateFromDisk(ctrl, item, channel);
        }
    };

    function updateNodeForDocument(e: vscode.TextDocument) {
        if (e.uri.scheme !== "file") {
            return;
        }

        if (!e.uri.path.endsWith(".feature")) {
            return;
        }

        if (e.uri.path.includes("node_modules")) {
            return;
        }

        const { file, data } = getOrCreateFile(ctrl, e.uri);
        data.updateFromContents(ctrl, e.getText(), file, channel);
    }

    for (const document of vscode.workspace.textDocuments) {
        updateNodeForDocument(document);
    }

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
        vscode.workspace.onDidChangeTextDocument((e) => updateNodeForDocument(e.document))
    );
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
    const existing = controller.items.get(uri.toString());
    if (existing) {
        return { file: existing, data: testData.get(existing) as TestFile };
    }

    const file = controller.createTestItem(uri.toString(), uri.path.split("/").pop()!, uri);
    controller.items.add(file);

    const data = new TestFile();
    testData.set(file, data);

    file.canResolveChildren = true;
    return { file, data };
}

function gatherTestItems(collection: vscode.TestItemCollection) {
    const items: vscode.TestItem[] = [];
    collection.forEach((item) => items.push(item));
    return items;
}

function getWorkspaceTestPatterns() {
    if (!vscode.workspace.workspaceFolders) {
        return [];
    }

    return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
        workspaceFolder,
        pattern: new vscode.RelativePattern(workspaceFolder, "**/*.feature"),
    }));
}

async function findInitialFiles(controller: vscode.TestController, pattern: vscode.GlobPattern) {
    for (const file of await vscode.workspace.findFiles(pattern)) {
        if (file.path.includes("node_modules")) {
            continue;
        }
        getOrCreateFile(controller, file);
    }
}

function startWatchingWorkspace(controller: vscode.TestController, fileChangedEmitter: vscode.EventEmitter<vscode.Uri>, logChannel: vscode.OutputChannel) {
    return getWorkspaceTestPatterns().map(({ workspaceFolder, pattern }) => {
        const watcher = vscode.workspace.createFileSystemWatcher(pattern);

        watcher.onDidCreate((uri) => {
            getOrCreateFile(controller, uri);
            fileChangedEmitter.fire(uri);
        });
        watcher.onDidChange(async (uri) => {
            const { file, data } = getOrCreateFile(controller, uri);
            if (data.didResolve) {
                await data.updateFromDisk(controller, file, logChannel);
            }
            fileChangedEmitter.fire(uri);
        });
        watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

        findInitialFiles(controller, pattern);

        return watcher;
    });
}

// This method is called when your extension is deactivated
export function deactivate() {}
