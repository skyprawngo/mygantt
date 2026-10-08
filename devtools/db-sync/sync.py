#!/usr/bin/env python3
"""Opt-in development tool for paired, SSH-only two-way MyGantt sync."""
import argparse, copy, ctypes, hashlib, json, os, pathlib, queue, select, shlex, sqlite3, subprocess, sys, threading, time
TABLES = ('templates','template_tasks','projects','project_tasks','project_creation_requests','app_settings')
ROOT = pathlib.Path(__file__).resolve().parent

def load_settings(env_file=None):
    """Read only the explicit file (or sibling .env); never discover peer hosts."""
    values = {}
    path = pathlib.Path(env_file) if env_file else ROOT / '.env'
    if path.is_file():
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#'): continue
            key, sep, value = line.partition('=')
            if not sep or not key.startswith('MYGANTT_SYNC_'):
                raise RuntimeError('Invalid synchronization configuration')
            values[key] = value.strip()
    values.update({key:value for key,value in os.environ.items() if key.startswith('MYGANTT_SYNC_')})
    return values

def authorize(settings, pair_id=None):
    if settings.get('MYGANTT_SYNC_ENABLED', '').lower() != 'true':
        raise RuntimeError('Development DB sync is disabled (MYGANTT_SYNC_ENABLED)')
    pair = settings.get('MYGANTT_SYNC_PAIR_ID', '')
    if not pair or (pair_id is not None and pair_id != pair):
        raise RuntimeError('Synchronization pair mismatch or missing pair ID')
    db = settings.get('MYGANTT_SYNC_DB', '')
    if not db or not pathlib.Path(db).is_absolute():
        raise RuntimeError('MYGANTT_SYNC_DB must be an explicit absolute path')
    return db

def coordinator_config(settings):
    db = authorize(settings)
    def required(key):
        value = settings.get('MYGANTT_SYNC_' + key, '')
        if not value: raise RuntimeError('Missing MYGANTT_SYNC_' + key)
        return value
    host = required('SSH_HOST')
    if host.startswith('-') or any(char.isspace() for char in host):
        raise RuntimeError('Invalid SSH host')
    return {'local_db':db, 'host':host, 'remote_script':required('REMOTE_SCRIPT'),
            'pair_id':required('PAIR_ID'), 'delay':max(300, int(settings.get('MYGANTT_SYNC_DELAY_SECONDS', '300')))}

def verify_binding(config):
    expected = {key:config[key] for key in ('local_db','host','remote_script','pair_id')}
    path = ROOT / 'binding.json'
    if not path.is_file() or json.loads(path.read_text()) != expected:
        raise RuntimeError('Pair baseline binding missing or changed; explicitly initialize a reviewed baseline first')

def remote_command(config, action):
    return ['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',
            '-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',config['host'],
            'python3 '+shlex.quote(config['remote_script'])+' '+action+' --pair-id '+shlex.quote(config['pair_id'])]

def atomic(path, value):
    path = pathlib.Path(path)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True))
    os.chmod(temp, 0o600)
    os.replace(temp, path)

class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try: return super().__exit__(*args)
        finally: self.close()

def connect(path):
    if not pathlib.Path(path).is_file(): raise RuntimeError('Database does not exist')
    db = sqlite3.connect(path, timeout=15, factory=Connection)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def snapshot(db):
    result = {'tables':{}, 'schema':{}, 'order':{}}
    for table in TABLES:
        cols = list(db.execute('PRAGMA table_info('+table+')'))
        result['schema'][table] = sorted([list(r)[1:6] for r in cols])
        pk = [r[1] for r in cols if r[5]]
        if len(pk)!=1: raise RuntimeError('Unsupported primary key: '+table)
        result['tables'][table] = {str(r[pk[0]]):dict(r) for r in db.execute('SELECT * FROM '+table)}
    result['order'] = {r['project_id']:r['sort_order'] for r in db.execute("SELECT project_id,sort_order FROM directory_entries WHERE kind='project'")}
    return result

def read(path):
    with connect(path) as db:
        db.execute('BEGIN')
        return snapshot(db)

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()

def backup(path):
    target = pathlib.Path(path).parent / 'sync-backups'
    target.mkdir(mode=0o700,exist_ok=True)
    dest = target / (time.strftime('%Y%m%d-%H%M%S')+'-'+str(time.time_ns())+'.sqlite3')
    with connect(path) as src, sqlite3.connect(dest, factory=Connection) as out: src.backup(out)
    os.chmod(dest,0o600)
    return str(dest)

def apply(path, expected, desired):
    validate_task_links(desired)
    saved = backup(path)
    with connect(path) as db:
        db.execute('BEGIN IMMEDIATE')
        tasks=desired['tables']['project_tasks']
        cross_project=any(tasks[dep]['project_id']!=row['project_id']
                          for row in tasks.values() for dep in json.loads(row.get('dependencies') or '[]'))
        if cross_project and not db.execute("SELECT 1 FROM sqlite_master WHERE type='view' AND name='task_links'").fetchone():
            raise RuntimeError('Cross-project links require the peer application migration first')
        before=snapshot(db)
        if digest(before)!=expected: raise RuntimeError('Database changed during synchronization; retry')
        if before['schema']!=desired['schema']: raise RuntimeError('Schema mismatch; update applications first')
        db.execute('PRAGMA defer_foreign_keys=ON')
        # Template saves regenerate task IDs; clear removed child rows before
        # inserting replacements with the same (template_id, task_key).
        for key in before['tables']['template_tasks'].keys()-desired['tables']['template_tasks'].keys():
            db.execute('DELETE FROM template_tasks WHERE id=?',(key,))
        # Parents first; never REPLACE, which would cascade-delete children.
        for table in TABLES:
            pk=next(c[0] for c in desired['schema'][table] if c[4])
            for key,row in desired['tables'][table].items():
                if before['tables'][table].get(key)==row: continue
                cols=list(row)
                sql='INSERT INTO '+table+' ('+','.join(cols)+') VALUES ('+','.join('?' for _ in cols)+') ON CONFLICT('+pk+') DO UPDATE SET '+','.join(c+'=excluded.'+c for c in cols if c!=pk)
                db.execute(sql,list(row.values()))
        for table in reversed(TABLES):
            pk=next(c[0] for c in desired['schema'][table] if c[4])
            for key in before['tables'][table].keys()-desired['tables'][table].keys():
                db.execute('DELETE FROM '+table+' WHERE '+pk+'=?',(key,))
        # Inserts append project order through a DB trigger; restore snapshot order
        # after all parent/child writes before synchronizing directory entries.
        for key,row in desired['tables']['projects'].items():
            if 'sort_order' in row:
                db.execute('UPDATE projects SET sort_order=? WHERE id=?',(row['sort_order'],key))
        for key,order in desired['order'].items():
            db.execute("UPDATE directory_entries SET sort_order=? WHERE project_id=? AND kind='project'",(order,key))
        if db.execute('PRAGMA foreign_key_check').fetchone(): raise RuntimeError('Foreign key validation failed')
        if snapshot(db)!=desired: raise RuntimeError('Post-apply verification failed')
    return {'backup':saved,'hash':digest(desired)}

def groups(value):
    # A project/template and its children are one conflict unit. This avoids
    # merging incompatible dependency graphs, task moves, or delete/edit races.
    result={}
    tables=value['tables']
    for table,children,parent,prefix in [('projects','project_tasks','project_id','project:'),('templates','template_tasks','template_id','template:')]:
        for key,row in tables[table].items():
            result[prefix+key]={'row':row,'children':{k:r for k,r in tables[children].items() if r[parent]==key}}
            if table=='projects':
                result[prefix+key]['order']=value['order'].get(key)
                result[prefix+key]['requests']={k:r for k,r in tables['project_creation_requests'].items() if r['project_id']==key}
    for key,row in tables['app_settings'].items(): result['setting:'+key]=row
    return result

def validate_task_links(value):
    tasks=value['tables']['project_tasks']
    incoming={key:set(json.loads(row.get('dependencies') or '[]')) for key,row in tasks.items()}
    outgoing={key:[] for key in tasks}
    for key,deps in incoming.items():
        if key in deps or not deps <= tasks.keys():
            raise RuntimeError('Invalid cross-project dependency reference')
        for dep in deps: outgoing[dep].append(key)
    ready=[key for key,deps in incoming.items() if not deps]
    visited=0
    while ready:
        key=ready.pop();visited+=1
        for child in outgoing[key]:
            incoming[child].remove(key)
            if not incoming[child]:ready.append(child)
    if visited!=len(tasks):raise RuntimeError('Cross-project dependency cycle')

def merge(base,local,remote):
    if not base['schema']==local['schema']==remote['schema']: raise RuntimeError('Schema mismatch; update applications first')
    b,l,r=map(groups,(base,local,remote)); merged={}; conflicts=[]
    for key in b.keys()|l.keys()|r.keys():
        old,left,right=b.get(key),l.get(key),r.get(key)
        if left==right: result=left
        elif left==old: result=right
        elif right==old: result=left
        else: conflicts.append(key);continue
        if result is not None: merged[key]=result
    if conflicts: return None,conflicts
    result={'schema':copy.deepcopy(base['schema']),'tables':{t:{} for t in TABLES},'order':{}}
    for key,value in merged.items():
        prefix,id=key.split(':',1)
        if prefix=='setting':result['tables']['app_settings'][id]=value;continue
        parent,child=('projects','project_tasks') if prefix=='project' else ('templates','template_tasks')
        result['tables'][parent][id]=value['row']
        for taskid,row in value['children'].items():
            if taskid in result['tables'][child]: return None,['task-move:'+taskid]
            result['tables'][child][taskid]=row
        if prefix=='project':
            result['tables']['project_creation_requests'].update(value['requests'])
            if value['order'] is not None: result['order'][id]=value['order']
    try: validate_task_links(result)
    except RuntimeError: return None,['cross-project-dependencies']
    return result,[]

def watch(path):
    # Watch the containing directory: SQLite may replace journals/WAL files.
    folder=str(pathlib.Path(path).parent); name=pathlib.Path(path).name
    if sys.platform=='darwin':
        kq=select.kqueue(); watched={}
        while True:
            for file in (folder,path,path+'-wal'):
                try: inode=os.stat(file).st_ino
                except FileNotFoundError: continue
                if file in watched and watched[file][1]==inode: continue
                if file in watched: os.close(watched[file][0])
                fd=os.open(file,os.O_RDONLY);watched[file]=(fd,inode)
                event=select.kevent(fd,filter=select.KQ_FILTER_VNODE,flags=select.KQ_EV_ADD|select.KQ_EV_CLEAR,fflags=select.KQ_NOTE_WRITE|select.KQ_NOTE_RENAME|select.KQ_NOTE_DELETE)
                kq.control([event],0,0)
            if kq.control(None,10,None): print('change',flush=True)

    else:
        libc=ctypes.CDLL(None,use_errno=True)
        fd=libc.inotify_init1(0)
        if fd<0 or libc.inotify_add_watch(fd,folder.encode(),0x8|0x80|0x100|0x2)<0: raise OSError(ctypes.get_errno(),'inotify')
        import struct
        while True:
            buf=os.read(fd,65536);offset=0;changed=False
            while offset<len(buf):
                wd,mask,cookie,n=struct.unpack_from('iIII',buf,offset)
                filename=buf[offset+16:offset+16+n].rstrip(b'\0').decode()
                offset+=16+n
                if mask&0x4000 or filename in (name,name+'-wal',name+'-journal'):changed=True
            if changed:print('change',flush=True)

def rpc(config,action,payload=None):
    cmd=remote_command(config,action)
    out=subprocess.run(cmd,input=json.dumps(payload) if payload is not None else '',text=True,capture_output=True,timeout=90)
    if out.returncode:raise RuntimeError(out.stderr.strip()[-1500:])
    return json.loads(out.stdout)

class BatchWindow:
    def __init__(self,delay=300):self.delay=delay;self.due=None;self.last=None
    def changed(self,now):
        if self.due is None:self.due=max(now+self.delay,(self.last or 0)+self.delay)
    def ready(self,now):return self.due is not None and now>=self.due
    def started(self,now):self.last=now;self.due=None

def daemon(config):
    verify_binding(config)
    events=queue.Queue();window=BatchWindow(config.get('delay',300))
    def monitor(remote):
        while True:
            process=None
            try:
                if remote:
                    cmd=remote_command(config,'watch')
                else:cmd=[sys.executable,str(ROOT/'sync.py'),'watch','--pair-id',config['pair_id']]
                process=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
                events.put('reconnect')
                for line in process.stdout: events.put('change')
            finally:
                if process is not None:process.kill();process.wait()
            time.sleep(10)
    for remote in (False,True):threading.Thread(target=monitor,args=(remote,),daemon=True).start()
    status=ROOT/'status.json';basefile=ROOT/'baseline.json'
    window.changed(time.monotonic())
    while True:
        try:
            events.get(timeout=max(0.01,min(30,(window.due-time.monotonic()) if window.due else 30)))
            was_idle = window.due is None
            window.changed(time.monotonic())
            if was_idle: atomic(status,{'state':'pending','due_at':time.time()+max(0,window.due-time.monotonic())})
        except queue.Empty:pass
        if not window.ready(time.monotonic()):continue
        window.started(time.monotonic())
        try:
            base=json.loads(basefile.read_text());local=read(config['local_db']);remote=rpc(config,'snapshot')
            desired,conflicts=merge(base,local,remote)
            if conflicts:
                atomic(ROOT/'conflict.json',{'time':time.time(),'keys':conflicts,'baseline':base,'local':local,'remote':remote})
                raise RuntimeError('Conflicts preserved in conflict.json: '+', '.join(conflicts))
            # Baseline advances only after both sides commit. If interrupted,
            # re-merging against the old baseline safely resumes the same plan.
            if remote!=desired:rpc(config,'apply',{'expected':digest(remote),'desired':desired})
            if local!=desired:apply(config['local_db'],digest(local),desired)
            atomic(basefile,desired)
            atomic(status,{'state':'healthy','checked_at':time.time(),'changed':local!=desired or remote!=desired,'hash':digest(desired)})
        except Exception as error:
            atomic(status,{'state':'blocked-or-retrying','time':time.time(),'error':str(error)})
            window.changed(time.monotonic())

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['snapshot','apply','watch','daemon','backup','check','initialize'])
    parser.add_argument('--pair-id')
    parser.add_argument('--source', choices=['local','remote'])
    args=parser.parse_args()
    try:
        settings=load_settings()
        if args.action=='initialize':
            config=coordinator_config(settings)
            if not args.source: raise RuntimeError('Explicit --source local or remote required')
            if (ROOT/'baseline.json').exists() or (ROOT/'binding.json').exists():
                raise RuntimeError('Existing baseline must not be overwritten')
            local=read(config['local_db']);remote=rpc(config,'snapshot')
            if local['schema']!=remote['schema']: raise RuntimeError('Schema mismatch')
            backup(config['local_db']);rpc(config,'backup')
            desired=remote if args.source=='remote' else local
            if args.source=='remote' and local!=desired:apply(config['local_db'],digest(local),desired)
            if args.source=='local' and remote!=desired:rpc(config,'apply',{'expected':digest(remote),'desired':desired})
            atomic(ROOT/'baseline.json',desired)
            atomic(ROOT/'binding.json',{key:config[key] for key in ('local_db','host','remote_script','pair_id')})
            print(json.dumps({'initialized':True}))
        elif args.action in ('daemon','check'):
            config=coordinator_config(settings)
            verify_binding(config)
            if args.action=='check':
                # Verify remote enablement/pairing/schema without changing either DB.
                remote=rpc(config,'snapshot')
                if read(config['local_db'])['schema'] != remote['schema']:
                    raise RuntimeError('Schema mismatch')
                print(json.dumps({'enabled':True,'peer_verified':True}))
            else: daemon(config)
        else:
            if not args.pair_id: raise RuntimeError('Peer pair ID required')
            db=authorize(settings,args.pair_id)
            if args.action=='snapshot':print(json.dumps(read(db)))
            elif args.action=='backup':print(json.dumps(backup(db)))
            elif args.action=='apply':
                payload=json.load(sys.stdin);print(json.dumps(apply(db,payload['expected'],payload['desired'])))
            elif args.action=='watch':watch(db)
    except (RuntimeError, ValueError, OSError) as error:
        print(str(error),file=sys.stderr)
        return 1
    return 0

if __name__=='__main__':
    sys.exit(main())
