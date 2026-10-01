from threading import Lock

import pytest
from src.utils.local_db import _QueryBuilder


def test_local_null_filter_matches_both_missing_and_null_names_with_parameterized_key():
    query = _QueryBuilder(None, Lock(), 'generations').is_('name', 'null')
    where, parameters = query._build_where()
    assert where == ' WHERE (doc->>%s) IS NULL'
    assert parameters == ['name']
    with pytest.raises(ValueError):
        query.is_('name', 'anything')


def test_embedded_null_filter_uses_the_correct_generation_alias():
    class Cursor:
        def fetchall(self): return []
    class Connection:
        def execute(self, sql, params):
            self.sql, self.params = sql, params
            return Cursor()
    connection = Connection()
    query = _QueryBuilder(connection, Lock(), 'orders')
    query.select('*, generations!inner(name)').is_('generations.name', None).execute()
    assert '(g.doc->>%s) IS NULL' in connection.sql
    assert connection.params[-1] == 'name'
