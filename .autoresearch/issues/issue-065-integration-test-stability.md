---
id: LOCAL-065
number: 65
title: "集成测试稳定性加固（容器化测试超时/串行度）+ architecture 超时"
type: infra
priority: high
state: done
readiness: done
dependencies: [LOCAL-022]
origin: discovered-during-execution
github_issue: 93
execution_mode: local-implementation
---

# LOCAL-065锛氶泦鎴愭祴璇曠ǔ瀹氭€у姞鍥猴紙瀹瑰櫒鍖栨祴璇曡秴鏃?涓茶搴︼級

## 闂

鍦ㄥ涓?subagent 骞惰杩愯銆丏ocker 瀹瑰櫒瀵嗛泦鍚姩鏃讹紝浠ヤ笅娴嬭瘯鍙嶅浠?5s 榛樿瓒呮椂澶辫触锛堥殧绂昏繍琛屽潎閫氳繃锛夛細`control-postgres`銆乣run-events-api`銆乣budget-ledger`銆乣mcp-stdio-postgres`銆乣tool-handler-assembly-postgres`銆乣web-search`锛屼互鍙?`tests/architecture/boundaries.spec.ts` 鐨?鐪熷疄宸ヤ綔鍖烘棤杩濊"鐢ㄤ緥銆傝繖浣挎湰鍦?`pnpm run verify` 涓嶅彲闈狅紙CI 鍦ㄩ殧绂?runner 涓婇€氳繃锛屾帺鐩栦簡闂锛夈€?
## 楠屾敹鏉′欢

- [ ] 瀹瑰櫒鍖栭泦鎴愭祴璇曡幏寰椾笌鍏剁湡瀹炶€楁椂鐩哥О鐨勬樉寮忚秴鏃讹紙鍦?vitest 閰嶇疆鎴栭€愮敤渚嬫樉寮忚缃級锛屼笉鍐嶄緷璧?5s 榛樿鍊笺€?- [ ] 骞惰搴﹀緱鍒版帶鍒讹細瀹瑰櫒鍖栭泦鎴愭祴璇曞湪鍙楁帶骞跺彂涓嬭繍琛岋紙渚嬪鐙珛 vitest project/涓茶缁勶級锛岄伩鍏嶅悓涓€鏃跺埢浜夋姠瀹瑰櫒涓庣鍙ｃ€?- [ ] `tests/architecture/boundaries.spec.ts` 鐨勭敤渚嬫樉寮忚缃秴鏃讹紙涓嶅緱淇敼璐熶緥鏂█鏁伴噺 7锛夈€?- [ ] 鍦?*婊¤礋杞?*涓嬮噸澶嶈繍琛?`pnpm run verify` 鑷冲皯 3 娆★紝鍏ㄩ儴閫氳繃锛堣褰曟瘡娆＄粨鏋滐級銆?- [ ] 涓嶉€氳繃鍒犻櫎娴嬭瘯銆佽烦杩囨祴璇曘€佹斁瀹芥柇瑷€鎴栭檷浣庤鐩栨潵"绋冲畾"銆?- [ ] 鑻ュ彂鐜版煇涓?flake 鐨勬牴鍥犱笉鏄秴鏃讹紙濡傜鍙?瀹瑰櫒鍚嶅啿绐併€佸叡浜复鏃剁洰褰曪級锛屽繀椤讳慨鏍瑰洜骞跺湪 PR 涓鏄庛€?
## 鎶€鏈畾浣?
- `platform/vitest.config.ts`锛堝強蹇呰鐨?project/涓茶閰嶇疆锛?- `platform/tests/**`锛堜粎瓒呮椂涓庡苟鍙戠浉鍏虫敼鍔級
- `platform/tests/architecture/boundaries.spec.ts`锛堜粎瓒呮椂锛?
## 楠岃瘉涓庡畬鎴愯瘉鎹?
婊¤礋杞戒笅 3 娆?`pnpm run verify` 鍏ㄧ豢锛涜褰曟瘡娆＄殑鑰楁椂涓庡苟鍙戣缃紱CI 閫氳繃銆?
## 杈圭晫

- 鍙仛娴嬭瘯绋冲畾鎬у姞鍥猴紝涓嶆敼浜у搧浠ｇ爜銆佷笉鏀规柇瑷€璇箟銆佷笉鍑忓皯瑕嗙洊銆?
