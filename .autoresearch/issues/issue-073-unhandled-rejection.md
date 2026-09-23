---
id: LOCAL-073
number: 73
title: "修复 publication-fence 故障注入测试的 unhandled rejection"
type: infra
priority: high
state: done
readiness: done
dependencies: [LOCAL-070]
origin: discovered-during-execution
github_issue: 147
execution_mode: local-implementation
---

**LOCAL-073** 路 type: `infra` 路 priority: `high`  Dependencies: #123  鏉ユ簮锛欳I锛圥R #146锛夋毚闇茬殑鐪熷疄缂洪櫡銆? ---  # LOCAL-073锛氫慨澶?publication-fence 鏁呴殰娉ㄥ叆娴嬭瘯鐨?unhandled rejection  ## 闂  `platform/tests/integration/publication-fence-postgres.spec.ts` 鐨?crash-reclaim 鐢ㄤ緥锛? ```ts const readPromise = materializer.read(readRequest, s.ctx) const dispatchPromise = faultingDispatcher.dispatchOnce(s.scopeRef, s.ctx) const concurrent = await readPromise                                  // 鍏?await read await expect(dispatchPromise).rejects.toThrow('simulated crash...')   // 涔嬪悗鎵嶆寕澶勭悊鍣?```  `dispatchPromise` 鍦ㄧ 2 琛屽垱寤猴紝浣?rejection 澶勭悊鍣ㄨ鍒扮 4 琛屾墠鎸備笂銆備腑闂?`await readPromise` 鏈熼棿鑻ユ敞鍏ョ殑 crash 宸茬粡 reject锛屽氨鏄?*鏈鐞嗙殑 Promise rejection**銆倂itest 鎶?`Vitest caught 1 unhandled error` 骞惰杩涚▼浠ラ潪 0 閫€鍑衡€斺€斿嵆浣?`Tests 1618 passed`銆? 杩欒В閲婁簡姝ゅ墠澶氭"骞惰璐熻浇涓嬪伓鍙戝け璐?鐨勭幇璞★細鏄惁鍦ㄧ獥鍙ｅ唴 reject 鍙栧喅浜庢椂搴忋€? ## 楠屾敹鏉′欢  - [ ] 鍦ㄥ垱寤?`dispatchPromise` 鐨勫悓涓€鍚屾娈靛唴鎸備笂 rejection 澶勭悊鍣紙`then(onFulfilled, onRejected)` 鎴栫瓑浠凤級锛岀獥鍙ｆ秷闄ゃ€?- [ ] 鏂█璇箟涓嶅彉锛氫粛鏂█璇ユ dispatch 浠?`simulated crash before the outbox mark` 澶辫触锛屼笖閲嶆姇閫掑悗 `generation` 涓嶅彉銆佺粨璁烘纭€?- [ ] 婊¤礋杞介噸澶嶈繍琛?`pnpm exec vitest run tests/integration/publication-fence-postgres.spec.ts` 鑷冲皯 5 娆″叏閮ㄩ€氳繃锛屼笖**涓嶅啀鍑虹幇 unhandled error**銆?- [ ] 鍏ㄩ噺 `pnpm run verify` 鑷冲皯 3 娆″叏缁夸笖鏃?unhandled error銆?- [ ] 涓嶅垹闄?璺宠繃娴嬭瘯銆佷笉鏀惧鏂█銆? ## 鎶€鏈畾浣? - `platform/tests/integration/publication-fence-postgres.spec.ts`  ## 楠岃瘉涓庡畬鎴愯瘉鎹? 鍗曟枃浠?5 娆?+ 鍏ㄩ噺 3 娆¤繍琛岃褰曪紙鍚?exit code 涓?unhandled error 璁℃暟锛夛紱CI 閫氳繃銆? ## 杈圭晫  - 鍙敼娴嬭瘯鐨?Promise 澶勭悊鏃跺簭锛屼笉鏀逛骇鍝佷唬鐮佷笌鏂█銆? 
