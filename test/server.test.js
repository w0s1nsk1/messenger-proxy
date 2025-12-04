const request = require('supertest');
const { app, parseSendInstruction, parseReadInstruction } = require('../src/server');

describe('server', () => {
  it('responds to health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('parseSendInstruction', () => {
  it('parses send command', () => {
    const res = parseSendInstruction('send Janek :: Cześć!');
    expect(res).toEqual({ conversation: 'Janek', message: 'Cześć!' });
  });

  it('returns null for other messages', () => {
    expect(parseSendInstruction('hello')).toBeNull();
  });
});

describe('parseReadInstruction', () => {
  it('parses read command with limit', () => {
    const res = parseReadInstruction('read Janek :: 3');
    expect(res).toEqual({ conversation: 'Janek', limit: 3 });
  });

  it('parses read command without limit', () => {
    const res = parseReadInstruction('read Janek');
    expect(res).toEqual({ conversation: 'Janek', limit: 5 });
  });

  it('returns null for other messages', () => {
    expect(parseReadInstruction('hello')).toBeNull();
  });
});

describe('/notify', () => {
  afterEach(() => {
    delete app.locals.sendMessage;
  });

  it('accepts valid payload and delegates to sendMessage', async () => {
    const mockSender = jest.fn().mockResolvedValue();
    app.locals.sendMessage = mockSender;

    const res = await request(app).post('/notify').send({ conversation: 'Janek', message: 'Hej' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: 'queued' });
    expect(mockSender).toHaveBeenCalledWith('Janek', 'Hej');
  });

  it('rejects invalid payload', async () => {
    const res = await request(app).post('/notify').send({ conversation: '' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'conversation and message are required' });
  });
});

describe('diffMessages', () => {
  const { diffMessages } = require('../src/server');

  it('returns all when no previous marker', () => {
    const res = diffMessages(null, [{ text: 'a' }, { text: 'b' }]);
    expect(res.newMessages).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect(res.lastSeenText).toBe('b');
  });

  it('returns only newer after last seen', () => {
    const res = diffMessages('b', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    expect(res.newMessages).toEqual([{ text: 'c' }]);
    expect(res.lastSeenText).toBe('c');
  });
});

describe('sqlite helper', () => {
  const originalSqlitePath = process.env.SQLITE_DB_PATH;

  afterEach(() => {
    if (typeof originalSqlitePath === 'undefined') {
      delete process.env.SQLITE_DB_PATH;
    } else {
      process.env.SQLITE_DB_PATH = originalSqlitePath;
    }
    jest.resetModules();
    jest.dontMock('sqlite3');
    jest.clearAllMocks();
  });

  it('no-ops when sqlite is not configured', async () => {
    delete process.env.SQLITE_DB_PATH;
    jest.resetModules();
    const { persistMessages } = require('../src/sqlite');
    const result = await persistMessages('conv', [{ text: 'Hej' }]);
    expect(result).toBe(false);
  });

  it('stores messages when sqlite3 driver is available', async () => {
    process.env.SQLITE_DB_PATH = './tmp/messages.sqlite';
    jest.resetModules();

    const execMock = jest.fn((_sql, cb) => cb && cb(null));
    const runMock = jest.fn((_sql, _params, cb) => cb && cb.call({ lastID: 1 }, null));

    jest.doMock('sqlite3', () => {
      function Database(_path, cb) {
        setImmediate(() => cb && cb(null));
      }
      Database.prototype.exec = function exec(sql, cb) {
        execMock(sql, cb);
      };
      Database.prototype.run = function run(sql, params, cb) {
        runMock(sql, params, cb);
      };
      const api = { Database };
      api.verbose = () => api;
      return api;
    });

    const { persistMessages } = require('../src/sqlite');
    const stored = await persistMessages(
      { key: 'conv-key', id: '123', name: 'Tomasz' },
      [{ sender: 'Janek', text: 'Siema' }]
    );

    expect(stored).toBe(true);
    expect(execMock).toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO messages'),
      ['conv-key', '123', 'Tomasz', 'Janek', 'Siema'],
      expect.any(Function)
    );
  });
});
