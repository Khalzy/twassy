import * as htmlparser2 from 'htmlparser2';
import * as postcss from 'postcss';
import * as sass from 'sass';
import * as vscode from 'vscode';
import postcssSelectorParser from 'postcss-selector-parser';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';

const supportedLanguages = new Set([
	'html',
	'javascript',
	'javascriptreact',
	'svelte',
	'typescript',
	'typescriptreact',
	'vue',
]);
const CLASSNAME_IDENTIFIER_KEY = /^(.+?)(-+)/;

const fileClassCache: Map<vscode.Uri, Set<string>> = new Map();
const globalClassSet: Set<string> = new Set();
const globalVariantMap: Map<string, Set<vscode.CompletionItem>> = new Map();
const getVariantKey = (variant: string) => {
	const [_, formattedKey] = CLASSNAME_IDENTIFIER_KEY.exec(variant) ?? [
		undefined,
		variant,
	];
	return formattedKey;
};

const extractClasses = (filePath: string) => {
	const classNames: Set<string> = new Set();
	const compiled = sass.compile(filePath);
	const root = postcss.parse(compiled.css.toString());
	root.walkRules((rule) => {
		for (const selector of rule.selectors) {
			postcssSelectorParser((selectors) => {
				selectors.walkClasses(({ value }) => {
					classNames.add(value);
				});
			}).processSync(selector);
		}
	});
	return classNames;
};

/** * Updates the class cache and global set for a given file. */
function updateCache(
	fileUri: vscode.Uri,
) {
	const newClasses = extractClasses(fileUri.path);
	const oldClasses = fileClassCache.get(fileUri) || new Set();
	for (const classname of oldClasses) {
		if (!newClasses.has(classname) && classname) {
			globalClassSet.delete(classname);
			const variantKey = getVariantKey(classname);
			const variantSet = globalVariantMap.get(variantKey);
			const variantSize = variantSet?.size ?? 0;
			if (variantSet && variantSize > 1) {
				const omitClass = [...variantSet].find(
					(completionItem) => completionItem.label === classname,
				);
				if (omitClass) {
					variantSet.delete(omitClass);
				}
				globalVariantMap.set(variantKey, variantSet);
			} else {
				globalVariantMap.delete(getVariantKey(classname));
			}
		}
	}
	for (const newClass of newClasses) {
		if (newClass) {
			const variantKey = getVariantKey(newClass);
			const variants = globalVariantMap.get(variantKey) || new Set();
			globalClassSet.add(newClass);
			const completionItem = new vscode.CompletionItem(
				newClass,
				vscode.CompletionItemKind.Class,
			);
			variants?.add(completionItem);
			globalVariantMap.set(variantKey, variants);
		}
	}
	fileClassCache.set(fileUri, newClasses);
}


/** * Handles file deletion by removing its associated classes. */
function handleFileDelete(
	fileUri: vscode.Uri,
) {
	const oldClasses = fileClassCache.get(fileUri) || new Set();
	for (const oldClass of oldClasses) {
		globalClassSet.delete(oldClass);
		globalVariantMap.delete(getVariantKey(oldClass));
	}
	fileClassCache.delete(fileUri);
}


/** * Sets up a file watcher to monitor changes to relevant files. */ function watchForChanges() {
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.scss'); // Adjust glob as needed
	watcher.onDidChange(async (uri) => {
		updateCache(uri);
	});
	watcher.onDidCreate(async (uri) => {
		updateCache(uri);
	});
	watcher.onDidDelete((uri) => {
		handleFileDelete(uri);
	});
	return watcher;
}


/** * Rescans the workspace for initial load of classes. */ async function initializeCache() {
	const files = await vscode.workspace.findFiles('**/*.scss');
	for (const file of files) {
		updateCache(file);
	}
}


function isInCvaContext(documentText: string, cursorOffset: number): boolean {
	try {
		const ast = parser.parse(documentText, {
			sourceType: 'module',
			plugins: ['jsx', 'typescript'],
		});
		let inContext = false;
		traverse(ast, {
			CallExpression(path) {
				const callee = path.node.callee;
				if (
					callee.type === 'Identifier' &&
					(callee.name === 'cva' || callee.name === 'cx')
				) {
					const stringArgs = path.node.arguments.find(
						(args) => args.type === 'StringLiteral',
					);
					if (stringArgs) {
						inContext = true;
						path.stop();
					}
				}
			},
		});
		return inContext;
	} catch (error) {
		return false;
	}
}


function isInHtmlContext(text: string, cursorOffset: number): boolean {
	let isInContext = false;
	const parser = new htmlparser2.Parser(
		{
			onopentag(_, attributes) {
				const isClass = 'class' in attributes;
				const isClassName = 'classname' in attributes;
				if (isClass || isClassName) {
					const classValue = isClass ? attributes.class : attributes.classname;
					const classStart = text.indexOf(classValue);
					const classEnd = classStart + classValue.length;
					if (cursorOffset >= classStart && cursorOffset <= classEnd) {
						isInContext = true;
					}
				}
			},
		},
		{ decodeEntities: true },
	);
	parser.write(text);
	parser.end();
	return isInContext;
}

async function triggerAutocompleteWithCompletions() {
	await vscode.commands.executeCommand('editor.action.triggerSuggest');
}

export function activate(context: vscode.ExtensionContext) {
	initializeCache();

	const watcher = watchForChanges();

	const documentChanges = vscode.workspace.onDidChangeTextDocument((event) => {
		const document = event.document;
		const activeDocument = vscode.window.activeTextEditor?.document;
		const isSupportedLanguage = supportedLanguages.has(document.languageId);

		if (
			!activeDocument ||
			!document ||
			document !== activeDocument ||
			!isSupportedLanguage
		) {
			return;
		}

		for (const changes of event.contentChanges) {
			const position = new vscode.Position(
				changes.range.start.line,
				changes.range.start.character,
			);
			const text = document.getText();
			const offset = document.offsetAt(position);
			const isRelevantContext =
				isInCvaContext(text, offset) || isInHtmlContext(text, offset);
			if (isRelevantContext) {
				triggerAutocompleteWithCompletions();
			}
		}
	});

	const completionProvider = vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: '*' },
		{
			async provideCompletionItems(document, position) {
				const globalSuggestions = [...globalVariantMap.values()].flatMap(
					(set) => [...set],
				);
				const text = document.getText();
				const offset = document.offsetAt(position);
				const isRelevantContext =
					isInCvaContext(text, offset) || isInHtmlContext(text, offset);
				if (!isRelevantContext) {
					return null;
				}
				return globalSuggestions;
			},
		},
	);
	context.subscriptions.push(watcher);
	context.subscriptions.push(completionProvider);
	context.subscriptions.push(documentChanges);
}

// This method is called when your extension is deactivated
export function deactivate() {
	fileClassCache.clear();
	globalClassSet.clear();
	globalVariantMap.clear();
}
