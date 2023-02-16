"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
function init(modules) {
    var ts = modules.typescript;
    var factory = modules.typescript.factory;
    function create(info) {
        var proxy = Object.create(null);
        var _loop_1 = function (k) {
            var x = info.languageService[k];
            proxy[k] = function () {
                var args = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    args[_i] = arguments[_i];
                }
                return x.apply(info.languageService, args);
            };
        };
        for (var _i = 0, _a = Object.keys(info.languageService); _i < _a.length; _i++) {
            var k = _a[_i];
            _loop_1(k);
        }
        function isEmptyCaseBlock(node) {
            for (var _i = 0, _a = node.caseBlock.clauses; _i < _a.length; _i++) {
                var c = _a[_i];
                for (var _b = 0, _c = c.statements; _b < _c.length; _b++) {
                    var s = _c[_b];
                    if (!ts.isBreakStatement(s))
                        return false;
                }
            }
            return node.caseBlock.getChildCount() === 3; // means clauses is empty. only ['{', SyntaxList, '}']
        }
        function extractEnumInfo(fileName, positionOrRange, simple) {
            var sourceFile = info.languageService.getProgram().getSourceFile(fileName);
            if (!sourceFile)
                return false;
            if (sourceFile.isDeclarationFile)
                return;
            var JavaScriptFileNodeFlags = 131072;
            var isJs = !!(sourceFile.flags & JavaScriptFileNodeFlags);
            var nodeAtCursor = findChildContainingPosition(sourceFile, positionOrRangeToNumber(positionOrRange));
            while (nodeAtCursor &&
                !ts.isSwitchStatement(nodeAtCursor)) {
                nodeAtCursor = nodeAtCursor.parent;
            }
            //Is the node is an empty switch statement?
            if (nodeAtCursor &&
                ts.isSwitchStatement(nodeAtCursor) &&
                isEmptyCaseBlock(nodeAtCursor)) // means clauses is empty. only ['{', SyntaxList, '}']
             {
                var typeChecker = info.languageService.getProgram().getTypeChecker();
                var expType = typeChecker.getTypeAtLocation(nodeAtCursor.expression);
                //Is the exp type is an Enum type?
                var list = extractEnumMemberList(expType, typeChecker, nodeAtCursor, isJs);
                if (list) {
                    if (simple)
                        return true;
                    var pos = nodeAtCursor.caseBlock.getStart() + 1;
                    return { pos: pos, caseBlockNode: nodeAtCursor.caseBlock, nodeList: list, switchNode: nodeAtCursor };
                }
            }
        }
        // Here starts our second behavior: a refactor that will always be suggested no matter where is the cursor and does nothing
        // overriding getApplicableRefactors we add our refactor metadata only if the user has the cursor on the place we desire, in our case a class or interface declaration identifier
        proxy.getApplicableRefactors = function (fileName, positionOrRange) {
            var refactors = info.languageService.getApplicableRefactors.apply(this, arguments) || [];
            var sourceFile = info.languageService.getProgram().getSourceFile(fileName);
            if (!sourceFile) {
                return refactors;
            }
            if (extractEnumInfo(fileName, positionOrRange, true)) {
                refactors.push({
                    name: 'complete-switch-case',
                    description: 'Complete on switch cases for enums and unions with nonReachable',
                    actions: [{ name: 'complete-switch-case', description: '✨ Complete Switch' }]
                });
            }
            return refactors;
        };
        proxy.getEditsForRefactor = function (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences) {
            var refactors = info.languageService.getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences);
            if (actionName === 'complete-switch-case') {
                var obj_1 = extractEnumInfo(fileName, positionOrRange, false);
                if (obj_1) {
                    var sourceFile_1 = info.languageService.getProgram().getSourceFile(fileName);
                    var clause_1 = [];
                    obj_1.nodeList.forEach(function (item) {
                        return clause_1.push(factory.createCaseClause(item, []));
                    });
                    clause_1.pop();
                    clause_1.push(factory.createCaseClause(obj_1.nodeList[obj_1.nodeList.length - 1], [factory.createBreakStatement(undefined)]));
                    var defaultClause = factory.createDefaultClause([factory.createExpressionStatement(factory.createCallExpression(factory.createIdentifier("notReachable"), undefined, 
                        // TODO: Complete with identifier
                        []))]);
                    ts.addSyntheticLeadingComment(defaultClause, ts.SyntaxKind.MultiLineCommentTrivia, " istanbul ignore next ", true);
                    clause_1.push(defaultClause);
                    var caseBlockNode = factory.createCaseBlock(clause_1);
                    var switchNode_1 = factory.createSwitchStatement(ts.getMutableClone(obj_1.switchNode.expression), caseBlockNode);
                    var edits = ts['textChanges'].ChangeTracker["with"]({
                        host: info.languageServiceHost,
                        formatContext: ts['formatting'].getFormatContext(formatOptions),
                        preferences: __assign(__assign({}, preferences), { quotePreference: 'single' })
                    }, function (tracker) { return tracker.replaceNode(sourceFile_1, obj_1.switchNode, switchNode_1, undefined); });
                    return { edits: edits };
                }
            }
            return refactors;
        };
        return proxy;
    }
    function extractEnumMemberList(type, typeChecker, node, isJs) {
        //enum is also a union
        if (type.flags & ts.TypeFlags.Union) {
            /*
            support
            class A{};
            class B{};
            type Union = 1|2|true|A|B;
            

            boolean is a Union => true|false
            */
            var trueType_1 = typeChecker['getTrueType']();
            var falseType_1 = typeChecker['getFalseType']();
            var unionType = type;
            var isAllLiterial = unionType.types.every(function (t) {
                var flag = t.flags;
                return (flag & ts.TypeFlags.NumberLiteral) ||
                    (flag & ts.TypeFlags.StringLiteral) ||
                    t === trueType_1 ||
                    t === falseType_1 ||
                    !isJs && (flag & ts.TypeFlags.Object) && (t.objectFlags & ts.ObjectFlags.Class); //class type. 'class A{}'
            });
            if (isAllLiterial) {
                return unionType.types.map(function (t) {
                    var lt = t;
                    if (!isJs && t.symbol)
                        return typeChecker.symbolToExpression(t.symbol, 0, node, 0);
                    if (t === trueType_1)
                        return factory.createTrue();
                    if (t === falseType_1)
                        return factory.createFalse();
                    return ts.createLiteral(lt.value);
                });
            }
        }
        return;
    }
    /**normalize the parameter so we are sure is of type number */
    function positionOrRangeToNumber(positionOrRange) {
        return typeof positionOrRange === 'number' ?
            positionOrRange :
            positionOrRange.pos;
    }
    /** from given position we find the child node that contains it */
    function findChildContainingPosition(sourceFile, position) {
        function find(node) {
            if (position >= node.getStart() && position < node.getEnd()) {
                //return ts.forEachChild(node, find) || node
                return node.forEachChild(find) || node;
            }
        }
        return find(sourceFile);
    }
    return { create: create };
}
module.exports = init;
