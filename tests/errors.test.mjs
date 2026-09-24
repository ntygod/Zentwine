import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../services/api/dist/app.js';
test('unknown thrown values cannot disclose stack or raw message',async()=>{
  for(const thrown of [new Error('fixture-secret'),{statusCode:422,message:'fixture-secret'},'fixture-secret']){
    const app=buildApp();
    app.get('/test-failure',async()=>{throw thrown;});
    try{const r=await app.inject('/test-failure');assert.ok(r.statusCode>=400);assert.equal(r.body.includes('fixture-secret'),false);assert.equal(r.body.includes('stack'),false);}finally{await app.close();}
  }
});
