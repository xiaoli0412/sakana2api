#!/usr/bin/env python3
# 多轮工具循环:模型连续调用两次工具后给出最终回答。
import asyncio, json, os, sys
from openai import AsyncOpenAI

TOOLS = [{
    "type": "function",
    "function": {
        "name": "bash",
        "description": "执行 shell 命令并返回输出",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
    },
}]

def fake_bash(cmd: str) -> str:
    # 模拟真实 bash:支持 && 组合与常用命令
    cmds = [c.strip() for c in cmd.split("&&")]
    outs = []
    for c in cmds:
        c = c.strip()
        if c == "ls -la" or c == "ls":
            outs.append("drwxr-xr-x  server.js\n-rw-r--r--  package.json\n")
        elif c == "pwd":
            outs.append("/home/user\n")
        elif c.startswith("echo "):
            outs.append(c[5:] + "\n")
        else:
            outs.append("bash: " + c + ": command not found\n")
    return "".join(outs)

async def one_round(client, messages, label):
    stream = await client.chat.completions.create(model="sakana-namazu", messages=messages, tools=TOOLS, stream=True, stream_options={"include_usage": True})
    tcs, text, finish = [], "", None
    async for chunk in stream:
        if not chunk.choices: continue
        ch = chunk.choices[0]
        if ch.finish_reason: finish = ch.finish_reason
        d = ch.delta
        if d and d.content: text += d.content
        for tc in d.tool_calls or []:
            idx = tc.index or 0
            while len(tcs) <= idx: tcs.append({})
            if tc.id: tcs[idx]["id"] = tc.id
            if tc.type: tcs[idx]["type"] = tc.type
            if tc.function:
                if tc.function.name: tcs[idx]["name"] = tc.function.name
                if tc.function.arguments: tcs[idx]["arguments"] = tcs[idx].get("arguments", "") + tc.function.arguments
    print(f"[{label}] finish={finish} tools={len(tcs)} content_len={len(text)}")
    return tcs, text

async def main():
    client = AsyncOpenAI(base_url=os.environ.get("SAKANA_BASE", "http://127.0.0.1:8899/v1"), api_key=os.environ.get("SAKANA_KEY", "sk-test"), timeout=120)
    messages = [{"role": "user", "content": "先列出当前目录文件，然后告诉我当前工作目录是哪里"}]
    for i in range(3):
        tcs, text = await one_round(client, messages, f"轮次{i+1}")
        if not tcs:
            print("最终回答:", text[:200])
            assert "server.js" in text and "home" in text or "user" in text
            break
        tc = tcs[0]
        args = json.loads(tc["arguments"])
        result = fake_bash(args["command"])
        messages.append({"role": "assistant", "content": None, "tool_calls": [{"id": tc["id"], "type": "function", "function": {"name": tc["name"], "arguments": tc["arguments"]}}]})
        messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
        print(f"  执行 {args['command']} -> {result.strip()}")
    else:
        print("FAILED: 三轮仍未结束"); sys.exit(1)
    print("MULTI-ROUND TOOL LOOP: ALL PASSED ✅")

asyncio.run(main())
