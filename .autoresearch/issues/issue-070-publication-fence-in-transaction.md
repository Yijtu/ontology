---
id: LOCAL-070
number: 70
title: "发布事务内开启失效围栏（消除 publish-commit→worker-consume 窗口）"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-031, LOCAL-033, LOCAL-069]
origin: discovered-during-execution
github_issue: 123
execution_mode: local-implementation
---

# LOCAL-070锛氬彂甯冧簨鍔″唴寮€鍚け鏁堝洿鏍?
## 闂

LOCAL-069 宸叉妸鐗╁寲娑堣垂鑰呮帴鍏?worker锛屼絾**鍥存爮鏄湪 worker 娑堣垂鍙戝竷 outbox 浜嬩欢鏃舵墠鎵撳紑鐨?*锛屽洜姝ゅ瓨鍦?`publish-commit 鈫?worker-consume` 绐楀彛锛氬湪璇ョ獥鍙ｅ唴鏌ヨ鍙兘杩斿洖**杩囨湡缁撹**锛堝凡鍙戝竷鐨勬柊浜嬪疄灏氭湭瑙﹀彂鍥存爮锛夈€係PEC ADR-13/D5 瑕佹眰鍙戝竷鍏堣 fence銆佸啀寮傛鎺ㄨ繘銆?
## 楠屾敹鏉′欢

- [ ] 璇箟鍙戝竷浜嬪姟鍦?*鍚屼竴浜嬪姟鍐?*鎵撳紑鍙楀奖鍝嶈寖鍥寸殑澶辨晥鍥存爮锛坒ence锛夛紝骞朵笌鍙戝竷 outbox 浜嬩欢鍘熷瓙鎻愪氦锛泈orker 涔嬪悗浠呰礋璐ｆ帹杩涖€?- [ ] 娑堥櫎绐楀彛锛氬彂甯冩彁浜ゅ悗**绔嬪嵆**鏌ヨ涓嶅緱杩斿洖杩囨湡缁撹锛堝湪 worker 娑堣垂鍓嶅嵆搴斾负 fenced锛夈€?- [ ] 骞傜瓑锛氶噸澶嶅彂甯?閲嶈瘯涓嶉噸澶嶆墦寮€鎴栭敊璇叧闂洿鏍忥紱宕╂簝閲嶉鍚庡洿鏍忕姸鎬佷竴鑷淬€?- [ ] 闆嗘垚娴嬭瘯锛氱湡瀹?PostgreSQL锛岃鐩栥€屽彂甯冩彁浜?鈫?绔嬪嵆鏌ヨ锛坒enced锛岄潪杩囨湡锛夆啋 worker 鎺ㄨ繘 鈫?鏂扮粨璁恒€嶏紱鍚苟鍙戞煡璇笌宕╂簝閲嶉銆?- [ ] 涓嶅墛寮辨棦鏈夋柇瑷€锛涗笉鏀瑰彂甯?鐗╁寲濂戠害璇箟銆?
## 鎶€鏈畾浣?
- `platform/packages/semantic-engine/src/publication/`
- `platform/packages/adapters/control-postgres/src/`锛坧ublication store锛?- `platform/packages/semantic-engine/src/materialization/`锛堝洿鏍忕鍙ｏ紝浠呭湪纭湁缂哄彛鏃讹級

## 楠岃瘉涓庡畬鎴愯瘉鎹?
`pnpm run verify` 鍏ㄧ豢锛涚湡瀹炲鍣ㄥ寲 PostgreSQL 鐨勭獥鍙ｆ秷闄や笌骞傜瓑闆嗘垚娴嬭瘯锛汣I 閫氳繃銆?
## 杈圭晫

- 鍙妸鍥存爮寮€鍚Щ鍏ュ彂甯冧簨鍔★紝涓嶆柊澧炵墿鍖栬兘鍔涖€佷笉鏀瑰彂甯冭涔夈€?- 涓嶅緱閫氳繃鍒犻櫎娴嬭瘯鎴栨斁瀹芥柇瑷€瀹屾垚浠诲姟銆?
