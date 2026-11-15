import {pathToFileURL} from 'node:url';
import {openDatabase} from './db.js';
import {migrateDatabase} from './migrations.js';
export async function migrate(){
 const connectionString=process.env.DATABASE_MIGRATION_URL||process.env.DATABASE_URL;
 if(process.env.VERCEL&&!connectionString)throw Error('Database connection required for deployment migrations');
 const db=await openDatabase({connectionString,migration:true});
 try{return await migrateDatabase(db);}finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)migrate().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error('Migration failed:',e.message);process.exitCode=1;});
