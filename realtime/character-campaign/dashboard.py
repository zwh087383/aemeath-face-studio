"""Free read-only campaign index and original-speed video playback."""
import argparse
import asyncio
import importlib.util
from pathlib import Path
import re
import sys
from aiohttp import web
from analyze import summarize

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]

def main():
    p=argparse.ArgumentParser();p.add_argument("--output",type=Path,required=True);p.add_argument("--port",type=int,default=18819);a=p.parse_args()
    output=a.output.resolve()
    spec=importlib.util.spec_from_file_location("campaign_dashboard_guard",ROOT/"realtime/qwen/server.py")
    guard=importlib.util.module_from_spec(spec);sys.modules[spec.name]=guard;spec.loader.exec_module(guard)
    def check(request):
        if not guard.allowed_request(request):raise web.HTTPForbidden()
    lock=asyncio.Lock()
    async def index(request):check(request);return web.FileResponse(HERE/"dashboard.html")
    async def summary(request):
        check(request)
        async with lock:value=await asyncio.to_thread(summarize,output)
        return web.json_response(value,headers={"Cache-Control":"no-store"})
    async def evidence(request):
        check(request);identity,name=request.match_info["identity"],request.match_info["name"]
        if not re.fullmatch(r"(?:single-\d{3}|(?:short|long)-\d{2})",identity) or not re.fullmatch(r"preview-[\w-]+\.(?:webm|png)",name):raise web.HTTPNotFound()
        path=output/"cases"/identity/name
        if not path.is_file():raise web.HTTPNotFound()
        return web.FileResponse(path)
    app=web.Application();app.router.add_get("/",index);app.router.add_get("/api/summary",summary);app.router.add_get("/case/{identity}/{name}",evidence)
    web.run_app(app,host="127.0.0.1",port=a.port)

if __name__=="__main__":main()
