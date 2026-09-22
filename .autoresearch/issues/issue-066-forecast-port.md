---
id: LOCAL-066
number: 66
title: "新增 ForecastPort 并按端口读取 forecast 输入"
type: backend
priority: high
state: done
readiness: done
dependencies: [LOCAL-043]
origin: discovered-during-execution
github_issue: 94
execution_mode: local-implementation
---

# LOCAL-066锛氭柊澧?ForecastPort 骞舵寜绔彛璇诲彇 forecast 杈撳叆

## 闂

SPEC 鐨?E1 澹版槑浜?forecast 绔彛锛屼絾 `@ontology/contracts` 娌℃湁 `ForecastPort`锛汱OCAL-043 鐨?forecast 杈撳叆鐩墠鏄竴涓湁鐣屻€佺増鏈寲鐨勫０鏄庡紡缁撴瀯锛岀敱璋冪敤鏂圭洿鎺ユ彁渚涳紝鏈蛋绔彛銆傚悗缁妭鐐癸紙LOCAL-045/046/052锛夐渶瑕佺粺涓€閫氳繃绔彛璇诲彇棰勬祴鏁版嵁銆?
## 楠屾敹鏉′欢

- [ ] 鍦?`@ontology/contracts` 鏂板 `ForecastPort`锛堝惈璇锋眰/缁撴灉涓?`SourceSnapshot`/鐗堟湰璇箟锛夛紝涓?`TelemetryPort` 椋庢牸涓€鑷淬€?- [ ] LOCAL-043 鐨勮兘婧愯緭鍏ヨ鑼冨寲鏀逛负**閫氳繃娉ㄥ叆鐨?ForecastPort** 璇诲彇 forecast锛堜繚鐣欐棦鏈?as-of 鏃犳硠婕忋€佸彂甯冩椂鍒?鏈夋晥绐楀彛/鐗堟湰璇箟锛夈€?- [ ] 鏈厤缃?forecast 鍚庣鏃舵樉寮?`not_configured`锛屼笉寰椾吉閫犻娴嬫暟鎹€?- [ ] 娴嬭瘯锛氬崟鍏冭鐩栫鍙ｅ绾︿笌 not_configured锛涢泦鎴愮敤鍙楁帶瀹炵幇璺戦€?as-of 杩囨护涓庣増鏈繚鐣欍€?- [ ] 涓嶆敼鍙樻棦鏈夎緭鍏ュ揩鐓ц涔夛紱涓嶅墛寮辨柇瑷€銆?
## 鎶€鏈畾浣?
- `platform/packages/contracts/src/`锛堢鍙ｏ級
- `platform/packages/extensions/home-energy/src/input/`锛堟敼涓虹鍙ｆ敞鍏ワ級

## 楠岃瘉涓庡畬鎴愯瘉鎹?
`pnpm run verify` 鍏ㄧ豢锛涘彈鎺?forecast 瀹炵幇涓嬬殑闆嗘垚娴嬭瘯锛汣I 閫氳繃銆?
## 杈圭晫

- 鍙姞绔彛涓庢帴绾匡紝涓嶅紩鍏ョ湡瀹為娴嬫湇鍔°€佷笉鏀瑰揩鐓ц涔夈€?- 涓嶅緱閫氳繃鍒犻櫎娴嬭瘯鎴栨斁瀹芥柇瑷€瀹屾垚浠诲姟銆?
