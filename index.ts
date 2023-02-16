function init(modules: { typescript: typeof import('typescript/lib/tsserverlibrary'); })
{
	const ts = modules.typescript;
	const factory = modules.typescript.factory;
	function create(info: ts.server.PluginCreateInfo): ts.LanguageService
	{
		const proxy: ts.LanguageService = Object.create(null);
		for (let k of Object.keys(info.languageService) as Array<keyof ts.LanguageService>)
		{
			const x = info.languageService[k];
			proxy[k] = (...args: Array<{}>) => x!.apply(info.languageService, args);
		}

		interface IGenInfo
		{
			pos: number;
			//list: string[];
			caseBlockNode: ts.Node;
			nodeList: ts.Expression[];
			switchNode: ts.SwitchStatement;
		}
		function isEmptyCaseBlock(node: ts.SwitchStatement)
		{
			for (let c of node.caseBlock.clauses)
			{
				for (let s of c.statements)
				{
					if (!ts.isBreakStatement(s))
						return false;
				}
			}
			return node.caseBlock.getChildCount() === 3;// means clauses is empty. only ['{', SyntaxList, '}']
		}

		function extractEnumInfo(fileName: string, positionOrRange: number | ts.TextRange, simple: false): IGenInfo;
		function extractEnumInfo(fileName: string, positionOrRange: number | ts.TextRange, simple: true): boolean;
		function extractEnumInfo(fileName: string, positionOrRange: number | ts.TextRange, simple: boolean): boolean | IGenInfo
		{
			const sourceFile = info.languageService.getProgram().getSourceFile(fileName);
			if (!sourceFile) return false;
			if (sourceFile.isDeclarationFile) return;
			const JavaScriptFileNodeFlags = 131072;
			const isJs = !!(sourceFile.flags & JavaScriptFileNodeFlags);
			let nodeAtCursor = findChildContainingPosition(sourceFile, positionOrRangeToNumber(positionOrRange));
			while (nodeAtCursor &&
				!ts.isSwitchStatement(nodeAtCursor))
			{
				nodeAtCursor = nodeAtCursor.parent;
			}
			//Is the node is an empty switch statement?
			if (nodeAtCursor &&
				ts.isSwitchStatement(nodeAtCursor) &&
				isEmptyCaseBlock(nodeAtCursor))// means clauses is empty. only ['{', SyntaxList, '}']
			{
				let typeChecker = info.languageService.getProgram().getTypeChecker();
				let expType = typeChecker.getTypeAtLocation(nodeAtCursor.expression);
				//Is the exp type is an Enum type?
				let list = extractEnumMemberList(expType, typeChecker, nodeAtCursor, isJs);
				if (list)
				{
					if (simple) return true;
					let pos = nodeAtCursor.caseBlock.getStart() + 1;
					return { pos, caseBlockNode: nodeAtCursor.caseBlock, nodeList: list, switchNode: nodeAtCursor };
				}
			}
		}

		// Here starts our second behavior: a refactor that will always be suggested no matter where is the cursor and does nothing
		// overriding getApplicableRefactors we add our refactor metadata only if the user has the cursor on the place we desire, in our case a class or interface declaration identifier
		proxy.getApplicableRefactors = function (fileName, positionOrRange): ts.ApplicableRefactorInfo[]
		{

			const refactors = info.languageService.getApplicableRefactors.apply(this, arguments) || [];
			const sourceFile = info.languageService.getProgram().getSourceFile(fileName);

			if (!sourceFile)
			{
				return refactors;
			}

			if (extractEnumInfo(fileName, positionOrRange, true))
			{
				refactors.push({
					name: 'complete-switch-case',
					description: 'Complete on switch cases for enums and unions with nonReachable',
					actions: [{ name: 'complete-switch-case', description: '✨ Complete Switch' }],
				});
			}

			return refactors;
		};

		proxy.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences) =>
		{
			const refactors = info.languageService.getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences);
			if (actionName === 'complete-switch-case')
			{
				let obj = extractEnumInfo(fileName, positionOrRange, false);
				if (obj)
				{
					const sourceFile = info.languageService.getProgram().getSourceFile(fileName);
					let clause: ts.CaseOrDefaultClause[] = [];

					obj.nodeList.forEach(item =>
						clause.push(factory.createCaseClause(item, []))
					);
					clause.pop()
					clause.push(factory.createCaseClause(obj.nodeList[obj.nodeList.length - 1], [factory.createBreakStatement(undefined)]))

					const defaultClause = factory.createDefaultClause([factory.createExpressionStatement(factory.createCallExpression(
						factory.createIdentifier("notReachable"),
						undefined,
						// TODO: Complete with identifier
						[]
					  ))])
					  
					ts.addSyntheticLeadingComment(defaultClause, ts.SyntaxKind.MultiLineCommentTrivia, " istanbul ignore next ", true);
					clause.push(defaultClause);
					let caseBlockNode = factory.createCaseBlock(clause);
					let switchNode = factory.createSwitchStatement(ts.getMutableClone(obj.switchNode.expression), caseBlockNode);

					let edits = ts['textChanges'].ChangeTracker.with({
						host: info.languageServiceHost,
						formatContext: ts['formatting'].getFormatContext(formatOptions),
						preferences: {
							...preferences,
							quotePreference: 'single'
						}
					}, (tracker) => tracker.replaceNode(sourceFile, obj.switchNode, switchNode, undefined));
					return { edits };
				}
			}
			return refactors;
		};


		return proxy;
	}

	function extractEnumMemberList(type: ts.Type, typeChecker: ts.TypeChecker, node: ts.Node, isJs: boolean): ts.Expression[] | undefined
	{
		//enum is also a union
		if (type.flags & ts.TypeFlags.Union)
		{
			/*
			support
			class A{};
			class B{};
			type Union = 1|2|true|A|B;
			

			boolean is a Union => true|false
			*/
			const trueType = typeChecker['getTrueType']();
			const falseType = typeChecker['getFalseType']();
			let unionType = type as ts.UnionType;
			let isAllLiterial = unionType.types.every(t =>
			{
				let flag = t.flags;

				return (flag & ts.TypeFlags.NumberLiteral) ||
					(flag & ts.TypeFlags.StringLiteral) ||
					t === trueType ||
					t === falseType ||
					!isJs && (flag & ts.TypeFlags.Object) && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Class);//class type. 'class A{}'
			});
			if (isAllLiterial)
			{
				return unionType.types.map(t =>
				{
					let lt = t as ts.LiteralType;
					if (!isJs && t.symbol) return typeChecker.symbolToExpression(t.symbol, 0, node, 0);
					if (t === trueType) return factory.createTrue();
					if (t === falseType) return factory.createFalse();
					return ts.createLiteral(lt.value);
				});
			}
		}
		return;
	}

	/**normalize the parameter so we are sure is of type number */
	function positionOrRangeToNumber(positionOrRange: number | ts.TextRange): number
	{
		return typeof positionOrRange === 'number' ?
			positionOrRange :
			(positionOrRange as ts.TextRange).pos;
	}

	/** from given position we find the child node that contains it */
	function findChildContainingPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined
	{
		function find(node: ts.Node): ts.Node | undefined
		{
			if (position >= node.getStart() && position < node.getEnd())
			{
				//return ts.forEachChild(node, find) || node
				return node.forEachChild(find) || node;
			}
		}

		return find(sourceFile);
	}

	return { create };
}

export = init;