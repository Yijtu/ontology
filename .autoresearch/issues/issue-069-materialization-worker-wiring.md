---
id: LOCAL-069
number: 69
title: "把 IncrementalMaterializer 接入 worker 装配并注册语义物化 outbox 消费者"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-033]
origin: discovered-during-execution
github_issue: 117
execution_mode: local-implementation
---

# LOCAL-069锛氭妸 IncrementalMaterializer 鎺ュ叆 worker 瑁呴厤骞舵敞鍐岃涔夌墿鍖?outbox 娑堣垂鑰?
## 闂

LOCAL-033 浜や粯浜嗗閲忕墿鍖栥€佸弻鏃舵€佹姇褰变笌澶辨晥鍥存爮锛屼絾鏈帴鍏?`apps/worker` 瑁呴厤锛氭病鏈夋妸 `IncrementalMaterializer` 娉ㄥ唽杩?worker锛屼篃娌℃湁娉ㄥ唽 `semantic.materialization.requested` 鐨?outbox 娑堣垂鑰呫€傜敓浜ц矾寰勪笂锛屽彂甯冧笉浼氭墦寮€ fence 骞舵帹杩涚墿鍖栥€?
## 楠屾敹鏉′欢

- [ ] 鍦?`apps/worker` 瑁呴厤涓瀯閫犲苟娉ㄥ唽 `IncrementalMaterializer`锛堜緷璧栫敱瑁呴厤鏍规敞鍏ワ級銆?- [ ] 娉ㄥ唽 `semantic.materialization.requested` outbox 娑堣垂鑰咃細璇箟鍙戝竷璺緞鎵撳紑 fence 骞跺叆闃熷彉鏇达紝worker 寮傛鎺ㄨ繘锛岄噸璇曞箓绛夈€佷笉閲嶅鎺ㄨ繘銆?- [ ] 闆嗘垚娴嬭瘯锛氱湡瀹?PostgreSQL + 鐪熷疄 outbox锛岀鍒扮銆屽彂甯?鈫?fence 鎵撳紑 鈫?worker 鎺ㄨ繘 鈫?鏌ヨ杩斿洖鏂扮粨璁恒€嶏紱鍚穿婧冮噸棰嗕笉閲嶅鎺ㄨ繘銆?- [ ] 鏈畬鎴愰噸绠楁椂鏌ヨ涓嶈繑鍥炶繃鏈熺粨璁猴紙娌跨敤 LOCAL-033 鐨?fence 璇箟锛夈€?- [ ] 涓嶅墛寮辨棦鏈夋柇瑷€锛涗笉鏀圭墿鍖?鍙戝竷濂戠害璇箟銆?
## 鎶€鏈畾浣?
- `platform/apps/worker/`
- `platform/packages/application/src/jobs/`锛堜粎鍦ㄧ‘鏈夌己鍙ｆ椂锛?
## 楠岃瘉涓庡畬鎴愯瘉鎹?
`pnpm run verify` 鍏ㄧ豢锛涚湡瀹炲鍣ㄥ寲 PostgreSQL 鐨勭鍒扮闆嗘垚娴嬭瘯锛汣I 閫氳繃銆?
## 杈圭晫

- 鍙仛瑁呴厤涓庢秷璐硅€呮帴绾匡紝涓嶆柊澧炵墿鍖栬兘鍔涖€佷笉鏀瑰彂甯冭涔夈€?- 涓嶅緱閫氳繃鍒犻櫎娴嬭瘯鎴栨斁瀹芥柇瑷€瀹屾垚浠诲姟銆?
