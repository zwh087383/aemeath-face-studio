"""Loopback-only local demo. No credentials, WAI bootstrap or cloud sockets."""
import argparse
import importlib.util
from pathlib import Path
import sys
from aiohttp import web

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wai-root",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--port",type=int,default=18805)
    args=parser.parse_args()
    sys.path.insert(0,str(args.wai_root))
    spec=importlib.util.spec_from_file_location("model_demo_app",Path(__file__).resolve().parents[1]/"parallel-duplex/app.py")
    app=importlib.util.module_from_spec(spec);spec.loader.exec_module(app)
    class Budget:
        data={"experimentId":"model-action-director-20261025","blocked":False}
        def snapshot(self):return {"turns":0,"turnLimit":0,"responses":0,"responseLimit":0,"reserved":0,"unknown":0,"blocked":False}
    args.output.mkdir(parents=True,exist_ok=True)
    web.run_app(app.create_app(None,None,Budget(),args.output,cloud=False,session_class=object,model_director=True),
                host="127.0.0.1",port=args.port,print=lambda _:print("Local model-director demo ready; cloud disabled",flush=True))

if __name__=="__main__":main()
