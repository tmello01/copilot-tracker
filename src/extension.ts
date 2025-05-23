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
        const lineCount = document.lineCount;
        
        if (!stats.fileStats[filePath]) {
            stats.fileStats[filePath] = { totalLines: 0, copilotLines: 0 };
        }

        const oldTotal = stats.fileStats[filePath].totalLines;
        if (oldTotal !== lineCount) {
            stats.fileStats[filePath].totalLines = lineCount;
            stats.totalLines = stats.totalLines - oldTotal + lineCount;
            stats.lastUpdated = new Date().toISOString();
            saveStats();
        }
    };

    // Listen for inline suggestions
    let inlineSuggestionDisposable = vscode.languages.registerInlineCompletionItemProvider('*', {
        provideInlineCompletionItems: async (document, position, context, token) => {
            // Store the current suggestion for later comparison
            if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
                const currentLine = document.lineAt(position.line).text;
                lastCopilotSuggestion = currentLine;
            }
            return [];
        }
    });

    // Listen for document changes
    let changeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
        const document = event.document;
        
        // Check if the change matches a Copilot suggestion
        const isCopilotChange = event.contentChanges.some(change => {
            const newText = change.text;
            const oldText = document.getText(change.range);
            
            // If the change matches a previously seen Copilot suggestion
            if (lastCopilotSuggestion && newText.includes(lastCopilotSuggestion)) {
                lastCopilotSuggestion = undefined; // Reset the suggestion
                return true;
            }
            
            // Check for typical Copilot patterns
            const isMultiLine = newText.includes('\n');
            const isCompleteStatement = newText.trim().endsWith(';') || 
                                      newText.trim().endsWith('}') || 
                                      newText.trim().endsWith(')');
            
            return isMultiLine && isCompleteStatement;
        });
        
        if (isCopilotChange) {
            const filePath = document.uri.fsPath;
            if (!stats.fileStats[filePath]) {
                stats.fileStats[filePath] = { totalLines: 0, copilotLines: 0 };
            }
            
            // Count new lines added by Copilot
            const newLines = event.contentChanges.reduce((count, change) => {
                return count + (change.text.split('\n').length - 1);
            }, 0);
            
            if (newLines > 0) {
                stats.fileStats[filePath].copilotLines += newLines;
                stats.copilotLines += newLines;
                stats.lastUpdated = new Date().toISOString();
                saveStats();
            }
        }
        
        updateFileStats(document);
    });

    // Listen for new documents
    let openDisposable = vscode.workspace.onDidOpenTextDocument(document => {
        updateFileStats(document);
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
        statusBarItem,
        inlineSuggestionDisposable
    );
}

function loadStats(context: vscode.ExtensionContext): CopilotStats | undefined {
    return context.globalState.get('copilotStats');
}

export function deactivate() {} 