type Row = Record<string, any>;

function uuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function createSeedData(): Record<string, Row[]> {
  const now = new Date().toISOString();
  const mk = (name: string, agency: string, external = false, company: string | null = null): Row => ({
    id: uuid(),
    operational_name: name,
    agency,
    presence_status: 'ausente',
    attendance_status: external ? 'parceiro' : 'livre',
    arrived_at: null,
    last_status_update: now,
    is_external_partner: external,
    external_company: company,
    sorteio_order: null,
    shift: null,
    afternoon_reserved: false,
    created_at: now,
  });
  return {
    brokers: [
      mk('João Silva', 'Viva Imóveis'),
      mk('Maria Santos', 'Viva Imóveis'),
      mk('Pedro Costa', 'Viva Imóveis'),
      mk('Ana Oliveira', 'Casa Nobre'),
      mk('Carlos Ferreira', 'Casa Nobre'),
      mk('Beatriz Lima', 'Casa Nobre'),
      mk('Roberto Parceiro', 'Externo', true, 'Imobiliária ABC'),
    ],
    visits: [],
    queue_entries: [],
    plantao_sessions: [],
  };
}

class MockChannel {
  on() { return this; }
  subscribe() { return this; }
}

class QueryBuilder {
  private table: string;
  private db: Record<string, Row[]>;
  private op: 'select' | 'insert' | 'update' | 'delete' | null = null;
  private cols = '*';
  private filters: { col: string; op: string; val: any }[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitVal: number | null = null;
  private payload: Row | Row[] | null = null;
  private wantReturn = false;

  constructor(table: string, db: Record<string, Row[]>) {
    this.table = table;
    this.db = db;
  }

  select(cols = '*') {
    if (this.op === 'insert') { this.wantReturn = true; this.cols = cols; }
    else { this.op = 'select'; this.cols = cols; }
    return this;
  }
  insert(data: Row | Row[]) { this.op = 'insert'; this.payload = data; return this; }
  update(data: Row) { this.op = 'update'; this.payload = data; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: any) { this.filters.push({ col, op: 'eq', val }); return this; }
  neq(col: string, val: any) { this.filters.push({ col, op: 'neq', val }); return this; }
  in(col: string, vals: any[]) { this.filters.push({ col, op: 'in', val: vals }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orderCol = col; this.orderAsc = opts?.ascending ?? true; return this; }
  limit(n: number) { this.limitVal = n; return this; }

  private matchFilters(row: Row): boolean {
    return this.filters.every(f => {
      if (f.op === 'eq') return row[f.col] === f.val;
      if (f.op === 'neq') return row[f.col] !== f.val;
      if (f.op === 'in') return f.val.includes(row[f.col]);
      return true;
    });
  }

  private resolve(row: Row): Row {
    if (this.cols === '*') return { ...row };
    const result: Row = {};
    for (const part of this.cols.split(',').map(s => s.trim())) {
      if (part === '*') {
        Object.assign(result, row);
      } else if (part.includes(':')) {
        const [alias, ref] = part.split(':');
        const m = ref.match(/^(\w+)\((.*)\)$/);
        if (m) {
          const [, tbl, c] = m;
          const fk = row[`${alias}_id`];
          const fkRow = (this.db[tbl] ?? []).find(r => r.id === fk);
          result[alias] = fkRow ? (c === '*' ? { ...fkRow } : {}) : null;
        }
      } else if (row[part] !== undefined) {
        result[part] = row[part];
      }
    }
    return result;
  }

  private execute(): { data: any; error: any } {
    try {
      const rows = this.db[this.table] ?? [];
      if (this.op === 'select') {
        let r = rows.filter(row => this.matchFilters(row));
        if (this.orderCol) {
          r = [...r].sort((a, b) => {
            const av = a[this.orderCol!], bv = b[this.orderCol!];
            if (av < bv) return this.orderAsc ? -1 : 1;
            if (av > bv) return this.orderAsc ? 1 : -1;
            return 0;
          });
        }
        if (this.limitVal != null) r = r.slice(0, this.limitVal);
        return { data: r.map(row => this.resolve(row)), error: null };
      }
      if (this.op === 'insert') {
        const items = Array.isArray(this.payload) ? this.payload : [this.payload];
        const inserted: Row[] = [];
        for (const d of items) {
          const row = { ...d };
          if (!row.id) row.id = uuid();
          if (!row.created_at) row.created_at = new Date().toISOString();
          if (!row.updated_at && this.table !== 'brokers') row.updated_at = row.created_at;
          this.db[this.table].push(row);
          inserted.push(row);
        }
        return { data: this.wantReturn ? inserted.map(r => this.resolve(r)) : null, error: null };
      }
      if (this.op === 'update') {
        const matched = rows.filter(row => this.matchFilters(row));
        const upd = this.payload as Row;
        for (const row of matched) Object.assign(row, upd);
        return { data: null, error: null };
      }
      if (this.op === 'delete') {
        const matched = rows.filter(row => this.matchFilters(row));
        const ids = new Set(matched.map(r => r.id));
        this.db[this.table] = rows.filter(r => !ids.has(r.id));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    } catch (e) {
      return { data: null, error: { message: String(e) } };
    }
  }

  then(onFulfilled?: (v: any) => any, onRejected?: (r: any) => any) {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }
  catch(onRejected: (r: any) => any) {
    return Promise.resolve(this.execute()).catch(onRejected);
  }
  single() {
    return Promise.resolve(this.execute()).then(r => {
      if (r.error) return { data: null, error: r.error };
      const arr = Array.isArray(r.data) ? r.data : [r.data];
      return { data: arr[0] ?? null, error: null };
    });
  }
  maybeSingle() {
    return Promise.resolve(this.execute()).then(r => {
      if (r.error) return { data: null, error: r.error };
      const arr = Array.isArray(r.data) ? r.data : [r.data];
      return { data: arr[0] ?? null, error: null };
    });
  }
}

export function createMockClient() {
  const data = createSeedData();
  return {
    from(table: string) { return new QueryBuilder(table, data); },
    channel() { return new MockChannel(); },
    removeChannel() {},
  };
}
