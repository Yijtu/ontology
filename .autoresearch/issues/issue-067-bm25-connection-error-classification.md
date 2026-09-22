---
id: LOCAL-067
number: 67
title: "search-bm25 连接层错误分类为 SOURCE_UNAVAILABLE"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-024, LOCAL-063]
origin: discovered-during-execution
github_issue: 95
execution_mode: local-implementation
---

# LOCAL-067锛歴earch-bm25 杩炴帴灞傞敊璇垎绫讳负 SOURCE_UNAVAILABLE

## 闂

`PostgresKeywordIndexStore.#withScope` 鐩存帴 rethrow 鍘熷 `pg` 杩炴帴閿欒锛屾湭鍋氬垎绫汇€傜湡瀹炴暟鎹簱涓嶅彲鐢ㄦ椂锛宼ool 璺緞涓婁粛琛ㄧ幇涓?`INTERNAL_ERROR`锛岃€?canonical 鐩綍涓?`SOURCE_UNAVAILABLE`锛?03锛屾湁闄愰噸璇曪級鎵嶆槸姝ｇ‘璇箟銆?
## 楠屾敹鏉′欢

- [ ] `search-bm25` 鐨勫瓨鍌ㄥ眰鎶婅繛鎺?缃戠粶绫诲け璐ワ紙濡?`ECONNREFUSED`/`ETIMEDOUT`/杩炴帴姹犺€楀敖/`57P01` 绛夛級鍒嗙被涓?canonical `SOURCE_UNAVAILABLE`锛涢潪杩炴帴绫诲け璐ヤ繚鎸佸師鏈夊垎绫汇€?- [ ] 鍒嗙被鍦?tool 璺緞涓婁繚鐪燂紙鐪熷疄 gateway 涓嶉檷绾э級銆?- [ ] 娴嬭瘯锛氬崟鍏冭鐩栬繛鎺ョ被閿欒鐨勫垎绫伙紱闆嗘垚鐢ㄧ湡瀹?PostgreSQL 瀹瑰櫒**鍋滄満**鍒堕€犺繛鎺ュけ璐ワ紝鏂█绔埌绔緱鍒?`SOURCE_UNAVAILABLE`锛?03锛屾湁闄愰噸璇曪級銆?- [ ] 涓嶆敼鍙樺叾浠栭敊璇爜璇箟锛涗笉鍓婂急鏂█銆?
## 鎶€鏈畾浣?
- `platform/packages/adapters/search-bm25/src/`锛坰tore/errors锛?
## 楠岃瘉涓庡畬鎴愯瘉鎹?
`pnpm run verify` 鍏ㄧ豢锛涚湡瀹炲鍣ㄥ仠鏈哄満鏅殑闆嗘垚娴嬭瘯锛汣I 閫氳繃銆?
## 杈圭晫

- 鍙仛閿欒鍒嗙被锛屼笉鏀规绱?绱㈠紩琛屼负銆?- 涓嶅緱閫氳繃鍒犻櫎娴嬭瘯鎴栨斁瀹芥柇瑷€瀹屾垚浠诲姟銆?
