import { createServer } from "node:http"; import { readFile } from "node:fs/promises"; import { join, extname } from "node:path";
const root = process.argv[2]; const port = +(process.argv[3]||8099);
const mime = { ".html":"text/html",".js":"text/javascript",".json":"application/json",".glb":"model/gltf-binary",".png":"image/png",".jpg":"image/jpeg" };
createServer(async (req,res)=>{ try{ let p=decodeURIComponent(req.url.split("?")[0]); if(p.endsWith("/"))p+="index.html"; const buf=await readFile(join(root,p)); res.setHeader("content-type",mime[extname(p)]||"application/octet-stream"); res.end(buf);}catch{res.statusCode=404;res.end("404");}}).listen(port,()=>console.log("static server on "+port));
