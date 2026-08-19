#!/usr/bin/env python3
# Astrbot 工具调用全流程模拟:openai SDK 客户端视角的完整回路验证。
# 流式:注册工具 → 解析 tool_calls → 执行 → tool 消息回传 → 最终回答。
import asyncio, json, os, sys
from openai import AsyncOpenAI

BASE = os.environ.get("SAKANA_BASE", "http://127.0.0.1:8899/v1")
KEY = os.environ.get("SAKANA_KEY", "sk-test")

TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "城市名"}},
            "required": ["city"],
        },
    },
}]

def fake_weather(city: str) -> str:
    return json.dumps({"city": city, "weather": "晴间多云", "temp": 28, "humidity": 45}, ensure_ascii=False)

async def main():
    client = AsyncOpenAI(base_url=BASE, api_key=KEY, timeout=120)
    # 1) 模型列表(Astrbot 启动必查)
    models = await client.models.list()
    ids = [m.id for m in models.data]
    print(f"[1] /v1/models -> {len(ids)} models, first={ids[0]}")
    assert "sakana-namazu" in ids, "模型列表缺少 sakana-namazu"

    messages = [{"role": "user", "content": "今天北京天气怎么样？帮我查一下"}]

    # 2) 流式调用,请求工具调用
    print("[2] 流式请求(include_usage=True, tools 注册)...")
    stream = await client.chat.completions.create(
        model="sakana-namazu",
        messages=messages,
        tools=TOOLS,
        stream=True,
        stream_options={"include_usage": True},
    )
    collected = {"content": "", "tool_calls": [], "finish": None, "usage": None, "chunks": 0, "raw_deltas": []}
    async for chunk in stream:
        collected["chunks"] += 1
        if chunk.usage is not None:
            collected["usage"] = chunk.usage
        if not chunk.choices:
            continue
        ch = chunk.choices[0]
        if ch.finish_reason is not None:
            collected["finish"] = ch.finish_reason
        d = ch.delta
        if d is None:
            continue
        if d.content:
            collected["content"] += d.content
        for tc in d.tool_calls or []:
            idx = tc.index if tc.index is not None else 0
            while len(collected["tool_calls"]) <= idx:
                collected["tool_calls"].append({})
            slot = collected["tool_calls"][idx]
            if tc.id:
                slot["id"] = tc.id
            if tc.type:
                slot["type"] = tc.type
            if tc.function:
                if tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function.arguments:
                    slot["arguments"] = slot.get("arguments", "") + tc.function.arguments
    print(f"    chunks={collected['chunks']} finish={collected['finish']}")
    print(f"    tool_calls={json.dumps(collected['tool_calls'], ensure_ascii=False)}")
    print(f"    usage={collected['usage']}")
    print(f"    content_len={len(collected['content'])}")
    assert collected["usage"] is not None, "usage 缺失(SDK include_usage 期望)"
    assert collected["finish"] == "tool_calls", f"finish_reason 应为 tool_calls,实际 {collected['finish']}"
    assert collected["tool_calls"], "没有解析到 tool_calls"

    tc = collected["tool_calls"][0]
    assert tc.get("id"), "tool_call 缺 id"
    assert tc.get("type") == "function", f"tool_call.type 应为 function,实际 {tc.get('type')}"
    assert tc.get("name"), "tool_call 缺 name"
    args = json.loads(tc["arguments"])  # Astrbot 会 json.loads
    print(f"[3] 解析 tool_call: name={tc['name']} args={args}")

    # 3) 执行工具,回传结果(role=tool)
    result = fake_weather(args["city"])
    messages.append({"role": "assistant", "content": None, "tool_calls": [{
        "id": tc["id"], "type": "function",
        "function": {"name": tc["name"], "arguments": tc["arguments"]},
    }]})
    messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})
    print(f"[4] 回传 tool 结果: {result}")

    # 4) 继续对话,期望模型基于工具结果总结
    final = await client.chat.completions.create(
        model="sakana-namazu",
        messages=messages,
        tools=TOOLS,
        stream=True,
        stream_options={"include_usage": True},
    )
    text = ""
    async for chunk in final:
        if chunk.choices and chunk.choices[0].delta and chunk.choices[0].delta.content:
            text += chunk.choices[0].delta.content
    print(f"[5] 最终回答: {text[:200]}")
    assert "晴" in text or "北京" in text, "最终回答未体现工具结果"
    print("\nASTRBOT TOOL FLOW: ALL PASSED ✅")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"\nFAILED ❌: {type(e).__name__}: {e}")
        sys.exit(1)
