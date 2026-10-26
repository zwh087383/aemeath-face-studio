// Reuse the reviewed asset routes and source-fingerprint checks unchanged.
import {createFacePreparationServer} from '../face-preparation-lab/server.mjs';
const at=process.argv.indexOf('--port'),port=at<0?18809:Number(process.argv[at+1]);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid_port');
const server=createFacePreparationServer();
server.listen(port,'127.0.0.1',()=>console.log(`Character assets: ${port}`));
