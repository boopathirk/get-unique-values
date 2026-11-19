import * as assert from 'assert';
import { Predicate, SearchMode, compilePredicates } from '../../csv/core/predicates';

const ci: SearchMode = { caseSensitive: false, wholeCell: false, regex: false };
const search = (query: string, column: number | null = null, mode: Partial<SearchMode> = {}): Predicate => ({
    kind: 'search', query, column, mode: { ...ci, ...mode },
});

suite('predicates', () => {
    test('contains is case-insensitive by default', () => {
        const { test } = compilePredicates([search('blue')]);
        assert.strictEqual(test(['A1', 'Big BLUE shirt']), true);
        assert.strictEqual(test(['A1', 'Red']), false);
    });

    test('match case', () => {
        const { test } = compilePredicates([search('Blue', null, { caseSensitive: true })]);
        assert.strictEqual(test(['Blue']), true);
        assert.strictEqual(test(['blue']), false);
    });

    test('whole cell', () => {
        const { test } = compilePredicates([search('blue', null, { wholeCell: true })]);
        assert.strictEqual(test(['BLUE']), true);
        assert.strictEqual(test(['blue shirt']), false);
    });

    test('regex, and regex + whole cell', () => {
        assert.strictEqual(compilePredicates([search('^A\\d+$', null, { regex: true })]).test(['x', 'A12']), true);
        assert.strictEqual(compilePredicates([search('A\\d', null, { regex: true, wholeCell: true })]).test(['A12']), false);
        assert.strictEqual(compilePredicates([search('A\\d+', null, { regex: true, wholeCell: true })]).test(['A12']), true);
    });

    test('invalid regex throws', () => {
        assert.throws(() => compilePredicates([search('(', null, { regex: true })]), SyntaxError);
    });

    test('column scope', () => {
        const { test } = compilePredicates([search('blue', 0)]);
        assert.strictEqual(test(['blue', 'x']), true);
        assert.strictEqual(test(['x', 'blue']), false);
    });

    test('columnIn includes empty cells and missing fields', () => {
        const { test } = compilePredicates([{ kind: 'columnIn', column: 2, values: [''] }]);
        assert.strictEqual(test(['a', 'b', '']), true);
        assert.strictEqual(test(['a', 'b']), true);
        assert.strictEqual(test(['a', 'b', 'x']), false);
    });

    test('predicates are ANDed', () => {
        const { test } = compilePredicates([search('blue'), { kind: 'columnIn', column: 2, values: ['10', '30'] }]);
        assert.strictEqual(test(['A1', 'Blue', '10']), true);
        assert.strictEqual(test(['A1', 'Blue', '20']), false);
        assert.strictEqual(test(['A1', 'Red', '10']), false);
    });

    test('badRows flag and empty detection', () => {
        assert.strictEqual(compilePredicates([{ kind: 'badRows' }]).badRowsOnly, true);
        assert.strictEqual(compilePredicates([{ kind: 'badRows' }]).empty, false);
        assert.strictEqual(compilePredicates([search('')]).empty, true);
        assert.strictEqual(compilePredicates([]).empty, true);
    });
});
