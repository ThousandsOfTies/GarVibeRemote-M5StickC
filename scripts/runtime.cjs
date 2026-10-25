// Each dependency lock gets a stable directory; running native serial addons
// must not be removed by another process preparing the same Product.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const generation=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'config/connection-node/package-lock.json'))).digest('hex').slice(0,16);
module.exports=path.join(root,'.gar/connection-node',generation);
