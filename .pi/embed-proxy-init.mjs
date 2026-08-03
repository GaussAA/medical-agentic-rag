// 嵌入服务专用：为 @huggingface/transformers 的 fetch 注入系统代理（undici）
import { setGlobalDispatcher, ProxyAgent } from "undici";
const proxy = process.env.PROXY_URL || "http://127.0.0.1:7897";
setGlobalDispatcher(new ProxyAgent(proxy));
