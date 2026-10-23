import {createNativeResourcesServer} from '../native-resources/server.mjs';
const at=process.argv.indexOf('--port'),port=at<0?18793:Number(process.argv[at+1]);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid port');
const server=createNativeResourcesServer();
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Skill reaction lab: http://127.0.0.1:${port}/skill-lab/`));
