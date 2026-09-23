---
id: LOCAL-072
number: 72
title: "为 adapter-model-company 增加 OpenAI 兼容解码路径"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-015, LOCAL-051]
origin: discovered-during-execution
github_issue: 144
execution_mode: local-implementation
---

**LOCAL-072** 路 type: `backend` 路 priority: `high`  Dependencies: #38, #142  鏉ユ簮锛歀OCAL-051 鐢ㄧ湡瀹炵鐐归獙璇佹椂鍙戠幇鐨勭湡瀹炵己闄凤紙闈炶嚜鎶ワ級銆? ---  # LOCAL-072锛氫负 adapter-model-company 澧炲姞 OpenAI 鍏煎瑙ｇ爜璺緞  ## 闂  LOCAL-051 鐢ㄧ湡瀹炲叕鍙哥綉鍏抽獙璇佹椂鍙戠幇锛?*绾跨骇鎺㈡祴閫氳繃**锛圚TTP 200 `text/event-stream`銆佺湡瀹炴ā鍨?`deepseek-v4-1-flash-260910`銆佺粨鏋勫寲 JSON銆乼ool-call 瀛楁銆乽sage 鍧囨纭級锛屼絾**閫傞厤鍣ㄨ矾寰勫け璐?*锛? - `GenerationPort` 璋冪敤鎶?`INTERNAL_ERROR: the provider stream contained an unrecognised chunk` - 鍏徃缃戝叧鏄?**OpenAI 鍏煎**锛坄/v1/chat/completions`锛孲SE `data: {...}` + `[DONE]`锛宼ool-call id 闈?UUID锛宍arguments` 鍒嗙墖娴佸紡杩斿洖锛?- 鑰?`adapter-model-company` 瀹炵幇鐨勬槸鍋囨兂鐨勭鏈?`{type:...}` 鍗忚  LOCAL-051 鏈慨锛屽洜涓鸿鍗＄姝㈡敼鍙?`tool_call_delta` 璇箟锛涙湰鍗″湪**涓嶆敼濂戠害璇箟**鐨勫墠鎻愪笅琛ラ綈瑙ｇ爜璺緞銆? ## 楠屾敹鏉′欢  - [ ] `adapter-model-company` 鏀寔 OpenAI 鍏煎鐨勬祦寮忚В鐮侊細`data:` 鍒嗙墖銆乣[DONE]` 缁堟銆乣delta.content` 鏂囨湰澧為噺銆乣delta.tool_calls` 鍒嗙墖绱姞銆乣finish_reason`銆乣usage`銆?- [ ] 闈?UUID 鐨?tool-call id 琚鑼冨寲涓哄绾﹀厑璁哥殑褰㈡€侊紱鍒嗙墖 `arguments` 绱姞涓哄畬鏁?JSON 鍚庢墠浜у嚭 `tool_call_delta` 鐨勫畬鏁村€欓€夛紱**涓嶆敼鍙?`tool_call_delta` 鐨勬棦鏈夊绾﹁涔?*銆?- [ ] 鐜版湁绉佹湁鍗忚璺緞涓嶅洖褰掞紙淇濈暀涓哄彲閫?codec锛夛紝鐢ㄥ彈鎺?fixture 瑕嗙洊涓ゆ潯璺緞銆?- [ ] 鐢?*鐪熷疄绔偣**璺戜竴娆?`scripts/validate-live-models.mjs`锛宍GenerationPort` 璺緞鐢?blocked 鍙樹负 validated锛涜褰曞欢杩?妯″瀷鐗堟湰/缁撴瀯鍖栬緭鍑?tool-call 缁撴灉銆?- [ ] JEV 浠嶄负 blocked锛坄ONTOLOGY_JEV_BASE_URL`/`ONTOLOGY_JEV_ENDPOINT` 涓虹┖锛夛紝涓嶅緱浼€犻€氳繃銆?- [ ] 涓嶆墦鍗?鎻愪氦浠讳綍瀵嗛挜锛涙姤鍛婁笉鍚瘑閽ュ€笺€? ## 鎶€鏈畾浣? - `platform/packages/adapters/model-company/` - `platform/scripts/validate-live-models.mjs`锛堜粎杩愯涓庢姤鍛婏級  ## 楠岃瘉涓庡畬鎴愯瘉鎹? `pnpm run verify` 鍏ㄧ豢锛堟棤瀵嗛挜锛孋I 璧扮‘瀹氭€ф浛韬級锛涚湡瀹炵鐐硅繍琛岃褰?`GenerationPort` validated锛涗袱鏉?codec 鐨勫彈鎺?fixture 娴嬭瘯锛涘瘑閽ヤ笉鍑虹幇鍦ㄦ姤鍛?鏃ュ織銆? ## 杈圭晫  - 鍙ˉ瑙ｇ爜璺緞涓?id 瑙勮寖鍖栵紝涓嶆敼 `GenerationPort` 濂戠害銆佷笉鏀归绠?鍙栨秷璇箟銆佷笉鎵ц宸ュ叿銆?- 涓嶅緱閫氳繃鍒犻櫎娴嬭瘯銆佹斁瀹芥柇瑷€鎴栦吉閫犵湡瀹炶皟鐢ㄥ畬鎴愪换鍔°€? 
