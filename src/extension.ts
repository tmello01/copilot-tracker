import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

interface CopilotStats {
    totalLines: number;
    copilotLines: number;
    lastUpdated: string;
    fileStats: { [key: string]: { totalLines: number; copilotLines: number } };
}

interface RepositoryStats {
    stats: CopilotStats;
    repository: string;
    lastUpdated: string;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Copilot Line Tracking is now active!');

    // Initialize or load stats from storage
    let stats: CopilotStats = loadStats(context) || {
        totalLines: 0,
        copilotLines: 0,
        lastUpdated: new Date().toISOString(),
        fileStats: {}
    };

    let lastSavedStats: string = JSON.stringify(stats);
    let saveTimeout: NodeJS.Timeout | undefined;
    let lastCopilotSuggestion: string | undefined;
    let isAcceptingSuggestion = false;
    let pendingCopilotLines: number = 0;

    // Function to clear all stats
    const clearStats = () => {
        stats = {
            totalLines: 0,
            copilotLines: 0,
            lastUpdated: new Date().toISOString(),
            fileStats: {}
        };
        lastSavedStats = JSON.stringify(stats);
        context.globalState.update('copilotStats', undefined);
        saveStatsToFile();
    };

    // Function to check if a file should be tracked
    const shouldTrackFile = (filePath: string): boolean => {
        // Skip temporary suggestion files
        if (filePath.includes('/response_') || filePath.includes('\\response_')) {
            return false;
        }

        // Skip files in .git directory
        if (filePath.includes('/.git/') || filePath.includes('\\.git\\')) {
            return false;
        }

        // Skip node_modules
        if (filePath.includes('/node_modules/') || filePath.includes('\\node_modules\\')) {
            return false;
        }

        // Skip the stats file itself
        if (filePath.endsWith('.copilot-stats.json')) {
            return false;
        }

        // Get tracked extensions from settings
        const config = vscode.workspace.getConfiguration('copilotLineTracking');
        const trackedExtensions = config.get<string[]>('trackedExtensions', [
            '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.h', '.hpp',
            '.cs', '.go', '.rb', '.php', '.swift', '.kt', '.rs', '.dart', '.vue',
            '.html', '.css', '.scss', '.sass', '.less', '.json', '.xml', '.yaml',
            '.yml', '.md', '.sql', '.sh', '.bash', '.ps1', '.schema'
        ]);

        return trackedExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
    };

    // Function to get repository root
    const getRepositoryRoot = (): string | undefined => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }
        return workspaceFolders[0].uri.fsPath;
    };

    // Function to save stats to JSON file
    const saveStatsToFile = () => {
        const repoRoot = getRepositoryRoot();
        if (!repoRoot) {
            return;
        }

        const currentStats = JSON.stringify(stats);
        if (currentStats === lastSavedStats) {
            return; // Don't save if nothing has changed
        }

        const statsFilePath = path.join(repoRoot, '.copilot-stats.json');
        const repositoryStats: RepositoryStats = {
            stats,
            repository: path.basename(repoRoot),
            lastUpdated: new Date().toISOString()
        };

        try {
            fs.writeFileSync(statsFilePath, JSON.stringify(repositoryStats, null, 2));
            lastSavedStats = currentStats;
        } catch (error) {
            console.error('Failed to save stats to file:', error);
        }
    };

    // Function to schedule a save
    const scheduleSave = () => {
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        saveTimeout = setTimeout(saveStatsToFile, 5000); // Debounce saves for 5 seconds
    };

    // Function to save stats
    const saveStats = () => {
        context.globalState.update('copilotStats', stats);
        scheduleSave();
    };

    // Function to update file stats
    const updateFileStats = (document: vscode.TextDocument) => {
        const filePath = document.uri.fsPath;
        
        // Skip files that shouldn't be tracked
        if (!shouldTrackFile(filePath)) {
            return;
        }

        const lineCount = document.lineCount;
        
        if (!stats.fileStats[filePath]) {
            stats.fileStats[filePath] = { totalLines: 0, copilotLines: 0 };
        }

        const oldTotal = stats.fileStats[filePath].totalLines;
        if (oldTotal !== lineCount) {
            // Update total lines
            stats.fileStats[filePath].totalLines = lineCount;
            stats.totalLines = stats.totalLines - oldTotal + lineCount;

            // If this is a new file and we have pending Copilot lines, assume they were all generated by Copilot
            if (oldTotal === 0 && pendingCopilotLines > 0) {
                stats.fileStats[filePath].copilotLines = Math.min(pendingCopilotLines, lineCount);
                stats.copilotLines += stats.fileStats[filePath].copilotLines;
                pendingCopilotLines = 0;
            }

            // Ensure copilot lines don't exceed total lines
            if (stats.fileStats[filePath].copilotLines > lineCount) {
                const excess = stats.fileStats[filePath].copilotLines - lineCount;
                stats.fileStats[filePath].copilotLines = lineCount;
                stats.copilotLines -= excess;
            }

            stats.lastUpdated = new Date().toISOString();
            saveStats();
        }
    };

    // Function to count non-empty lines in text
    const countNonEmptyLines = (text: string): number => {
        return text.split('\n').filter(line => line.trim().length > 0).length;
    };

    // Listen for inline suggestions
    let inlineSuggestionDisposable = vscode.languages.registerInlineCompletionItemProvider('*', {
        provideInlineCompletionItems: async (document, position, context, token) => {
            if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
                const currentLine = document.lineAt(position.line).text;
                lastCopilotSuggestion = currentLine;
                isAcceptingSuggestion = true;
            }
            return [];
        }
    });

    // Listen for document changes
    let changeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        const filePath = document.uri.fsPath;

        // Skip files that shouldn't be tracked
        if (!shouldTrackFile(filePath)) {
            return;
        }
        
        // Check if the change matches a Copilot suggestion
        const isCopilotChange = event.contentChanges.some(change => {
            const newText = change.text;
            
            // If we're currently accepting a suggestion
            if (isAcceptingSuggestion) {
                isAcceptingSuggestion = false;
                return true;
            }
            
            // If the change matches a previously seen Copilot suggestion
            if (lastCopilotSuggestion && newText.includes(lastCopilotSuggestion)) {
                lastCopilotSuggestion = undefined;
                return true;
            }
            
            // Check for typical Copilot patterns
            const isMultiLine = newText.includes('\n');
            const isCompleteStatement = newText.trim().endsWith(';') || 
                                      newText.trim().endsWith('}') || 
                                      newText.trim().endsWith(')') ||
                                      newText.trim().endsWith(']') ||
                                      newText.trim().endsWith('"') ||
                                      newText.trim().endsWith("'");
            
            return isMultiLine || isCompleteStatement;
        });
        
        if (isCopilotChange) {
            if (!stats.fileStats[filePath]) {
                stats.fileStats[filePath] = { totalLines: 0, copilotLines: 0 };
            }
            
            // Count new lines added by Copilot
            const newLines = event.contentChanges.reduce((count, change) => {
                return count + countNonEmptyLines(change.text);
            }, 0);
            
            if (newLines > 0) {
                // If this is a new file, store the lines as pending
                if (stats.fileStats[filePath].totalLines === 0) {
                    pendingCopilotLines += newLines;
                } else {
                    const currentTotal = stats.fileStats[filePath].totalLines;
                    const currentCopilot = stats.fileStats[filePath].copilotLines;
                    const newCopilotTotal = currentCopilot + newLines;

                    // Ensure we don't exceed total lines
                    if (newCopilotTotal <= currentTotal) {
                        stats.fileStats[filePath].copilotLines = newCopilotTotal;
                        stats.copilotLines += newLines;
                        stats.lastUpdated = new Date().toISOString();
                        saveStats();
                    }
                }
            }
        }
        
        updateFileStats(document);
    });

    // Listen for new documents
    let openDisposable = vscode.workspace.onDidOpenTextDocument(document => {
        updateFileStats(document);
    });

    // Listen for configuration changes
    let configDisposable = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('copilotLineTracking')) {
            // Recalculate stats for all open documents
            vscode.workspace.textDocuments.forEach(document => {
                updateFileStats(document);
            });
        }
    });

    // Register the command to show stats
    let statsDisposable = vscode.commands.registerCommand('copilot-line-tracking.showStats', () => {
        const percentage = stats.totalLines > 0 
            ? ((stats.copilotLines / stats.totalLines) * 100).toFixed(2)
            : '0.00';
            
        vscode.window.showInformationMessage(
            `Copilot Stats:\n` +
            `Total Lines: ${stats.totalLines}\n` +
            `Copilot Lines: ${stats.copilotLines}\n` +
            `Percentage: ${percentage}%\n` +
            `Last Updated: ${new Date(stats.lastUpdated).toLocaleString()}`
        );
    });

    // Register the command to clear stats
    let clearStatsDisposable = vscode.commands.registerCommand('copilot-line-tracking.clearStats', () => {
        clearStats();
        vscode.window.showInformationMessage('Copilot stats have been cleared.');
    });

    // Add status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'copilot-line-tracking.showStats';
    context.subscriptions.push(statusBarItem);

    // Update status bar item
    const updateStatusBar = () => {
        const percentage = stats.totalLines > 0 
            ? ((stats.copilotLines / stats.totalLines) * 100).toFixed(1)
            : '0.0';
        statusBarItem.text = `$(github) Copilot: ${percentage}%`;
        statusBarItem.show();
    };

    // Update status bar periodically
    setInterval(updateStatusBar, 5000);
    updateStatusBar();

    // Initial save
    saveStatsToFile();

    context.subscriptions.push(
        changeDisposable, 
        openDisposable, 
        statsDisposable,
        clearStatsDisposable,
        statusBarItem,
        inlineSuggestionDisposable,
        configDisposable
    );
}

function loadStats(context: vscode.ExtensionContext): CopilotStats | undefined {
    return context.globalState.get('copilotStats');
}

export function deactivate() {} 