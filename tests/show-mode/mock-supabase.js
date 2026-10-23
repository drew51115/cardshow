(function(){
  const today = new Date().toLocaleDateString('en-CA');
  const UID = 'u1';
  const S = window.__srv = JSON.parse(localStorage.getItem('__srv') || 'null') || {
    sellers: [{ id: UID, handle: 'tester', display_name: 'Tester', onboarding_complete: true, onboarding_state: null }],
    admins: [],
    shows: [{ id:'show_a', name:'Monster Show', date:'Today', location:'Cal Expo, Sacramento, CA', status:'active', access_code:'MON', start_date: today, end_date: today }],
    show_sellers: [{ show_id:'show_a', seller_id: UID, table_number:'12' }],
    inventory: [
      { id:'c1', seller_id:UID, card_title:'2024 Bowman Chrome Dylan Crews', player:'Dylan Crews', year:2024, card_set:'Bowman Chrome', card_number:'BCP-1', grader:'PSA', grade:10, cert_number:'12345678', price:120, status:'Available' },
      { id:'c2', seller_id:UID, card_title:'2023 Topps Chrome Elly De La Cruz', player:'Elly De La Cruz', year:2023, card_set:'Topps Chrome', grader:null, grade:null, price:40, status:'Available' },
      { id:'c3', seller_id:UID, card_title:'2018 Prizm Luka Doncic', player:'Luka Doncic', year:2018, card_set:'Prizm', grader:'PSA', grade:9, price:300, status:'Sold', sold_price:280, payment_method:'Venmo', sold_time:'1:05 PM', sold_date: today },
    ],
    show_inventory: [{ show_id:'show_a', card_id:'c1' }, { show_id:'show_a', card_id:'c2' }],
    sales: [], card_captures: [], show_floor_transactions: [], storage: [], show_events: [],
    cert_trust_checks: [], gtcr_consent_events: [],
  };
  const save = () => localStorage.setItem('__srv', JSON.stringify(S));
  const offline = () => !navigator.onLine;
  const netErr = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 };
  window.__mockLog = [];
  function q(table){
    let rows = null, single=false, op='select', payload=null, filters=[], opts={};
    const b = {
      select(){ return b; }, order(){ return b; }, range(){ return b; }, limit(){ return b; },
      eq(c,v){ filters.push(r=>String(r[c])===String(v)); return b; },
      neq(c,v){ filters.push(r=>String(r[c])!==String(v)); return b; },
      in(c,vs){ filters.push(r=>vs.map(String).includes(String(r[c]))); return b; },
      is(c,v){ filters.push(r=> v===null ? (r[c]==null) : r[c]===v); return b; },
      gte(c,v){ filters.push(r=> String(r[c]) >= String(v)); return b; },
      not(){ return b; }, lte(){ return b; }, ilike(){ return b; }, or(){ return b; }, filter(){ return b; },
      maybeSingle(){ single=true; return b; }, single(){ single=true; return b; },
      insert(p){ op='insert'; payload=p; return b; },
      upsert(p,o){ op='upsert'; payload=p; opts=o||{}; return b; },
      update(p){ op='update'; payload=p; return b; },
      delete(){ op='delete'; return b; },
      then(res, rej){
        if (offline()) return Promise.resolve(netErr).then(res, rej);
        window.__mockLog.push({table, op, payload});
        const T = (S[table] = S[table] || []);
        let out = { data: null, error: null, status: 200 };
        const match = r => filters.every(f => f(r));
        if (op === 'select') { const d = T.filter(match); out.data = single ? (d[0]||null) : d; }
        else if (op === 'insert' || op === 'upsert') {
          const list = Array.isArray(payload) ? payload : [payload];
          for (const p of list) {
            const row = Object.assign({ id: p.id || ('gen_' + Math.random().toString(36).slice(2)) }, p);
            if (table === 'card_captures') row.status = row.status || 'unattached';
            if (table === 'show_floor_transactions' && row.client_sale_id && T.some(r => r.client_sale_id === row.client_sale_id)) {
              out = { data:null, error:{ message:'duplicate key value violates unique constraint', code:'23505' }, status:409 }; continue;
            }
            const existing = T.find(r => r.id === row.id);
            if (existing) { if (op === 'upsert' && !opts.ignoreDuplicates) Object.assign(existing, row); }
            else T.push(row);
          }
          out.data = single ? { id: list[0].id || T[T.length-1].id } : list.map(p => ({ id: p.id }));
        }
        else if (op === 'update') { T.filter(match).forEach(r => Object.assign(r, payload)); }
        else if (op === 'delete') { S[table] = T.filter(r => !match(r)); }
        save();
        return Promise.resolve(out).then(res, rej);
      },
    };
    return b;
  }
  function rpc(name, a){
    if (offline()) return Promise.resolve(netErr);
    window.__mockLog.push({ table: 'rpc', op: name, payload: a });
    let data = null;
    if (name === 'record_sale') {
      const ex = S.sales.find(s => s.client_sale_id === a.p_client_sale_id);
      if (ex) data = { created:false, sale_id: ex.id, inventory_id: ex.inventory_id, status: ex.status, sold_at: ex.sold_at };
      else {
        let invId = a.p_inventory_id;
        if (invId) {
          const inv = S.inventory.find(r => r.id === invId);
          if (!inv) return Promise.resolve({ data:null, error:{ message:'item_not_found', code:'P0002' }, status:400 });
          if ((inv.status||'').toLowerCase() === 'sold') { data = { error:'already_sold', inventory_id: invId }; save(); return Promise.resolve({ data, error:null, status:200 }); }
          Object.assign(inv, { status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time });
        } else {
          invId = a.p_new_item.id;
          S.inventory.push(Object.assign({}, a.p_new_item, { seller_id: UID, status:'Sold', sold_price:a.p_price, payment_method:a.p_payment_method, sold_date:a.p_sold_date, sold_time:a.p_sold_time, source:a.p_source }));
        }
        if (a.p_show_id && !S.show_inventory.some(r => r.show_id===a.p_show_id && r.card_id===invId)) S.show_inventory.push({ show_id:a.p_show_id, card_id:invId });
        const sale = { id:'sale_'+S.sales.length, client_sale_id:a.p_client_sale_id, seller_id:UID, show_id:a.p_show_id, inventory_id:invId, capture_id:a.p_capture_id, price:a.p_price, payment_method:a.p_payment_method, buyer_handle:a.p_buyer_handle, source:a.p_source, status:'completed', sold_at:new Date().toISOString() };
        S.sales.push(sale);
        if (a.p_capture_id) { const c = S.card_captures.find(x => x.id === a.p_capture_id); if (c) { Object.assign(c, { inventory_id:invId, sale_id:sale.id, status:'attached' }); const inv = S.inventory.find(r=>r.id===invId); if (inv && !inv.primary_capture_id) inv.primary_capture_id = a.p_capture_id; } }
        data = { created:true, sale_id:sale.id, inventory_id:invId, status:'completed', sold_at:sale.sold_at };
      }
    } else if (name === 'void_sale') {
      const s = S.sales.find(x => x.client_sale_id === a.p_client_sale_id);
      if (s.status === 'voided') data = { voided:false, status:'voided' };
      else {
        s.status = 'voided';
        const inv = S.inventory.find(r => r.id === s.inventory_id);
        Object.assign(inv, { status:'Available', sold_price:null, payment_method:null, sold_date:null, sold_time:null });
        const tx = S.show_floor_transactions.find(t => t.client_sale_id === s.client_sale_id);
        if (tx) S.show_floor_transactions.push(Object.assign({}, tx, { id:'rev_'+tx.id, client_sale_id:null, sold_price:-tx.sold_price, voids_transaction_id:tx.id }));
        data = { voided:true, status:'voided', inventory_id:s.inventory_id };
      }
    }
    save();
    return Promise.resolve({ data, error:null, status:200 });
  }
  window.supabase = { createClient(){ return {
    from: q, rpc,
    channel(){ const c={ on(){return c;}, subscribe(){return c;} }; return c; },
    removeChannel(){},
    storage: { from(){ return {
      upload: async (key)=>{ if (offline()) return { error:{ message:'Failed to fetch' } }; S.storage.push(key); save(); return { error:null }; },
      createSignedUrl: async ()=>({ data:{ signedUrl:'' } }),
      getPublicUrl: ()=>({ data:{ publicUrl:'' } }),
    }; } },
    auth: {
      async getSession(){ const s=localStorage.getItem('mock_session'); return { data:{ session: s? JSON.parse(s):null } }; },
      async signOut(){ localStorage.removeItem('mock_session'); return {error:null}; },
      async signInWithPassword(){ const s={user:{id:UID,email:'t@x.com'},access_token:'t'}; localStorage.setItem('mock_session',JSON.stringify(s)); return {data:{session:s,user:s.user},error:null}; },
      async getUser(){ const s=localStorage.getItem('mock_session'); return {data:{user:s?JSON.parse(s).user:null}}; },
      onAuthStateChange(){ return {data:{subscription:{unsubscribe(){}}}}; },
    },
  }; } };
})();
