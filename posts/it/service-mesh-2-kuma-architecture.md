---
title: "[서비스 메시 2편] Kuma 아키텍처 파헤치기 - IaaS 환경에 맞는 서비스 메시 고르기"
category: "IT"
date: "2026-08-05"
tags: ["IT", "서비스메시", "ServiceMesh", "Kuma", "Envoy", "IaaS", "인프라", "개발자"]
naverCategory: "IT·컴퓨터"
---

# [서비스 메시 2편] Kuma 아키텍처 파헤치기 - IaaS 환경에 맞는 서비스 메시 고르기

[1편](#)에서 서비스 메시가 왜 필요한지 개념을 짚어봤다면, 이번 편에서는 **왜 하필 Kuma였는지**, 그리고 Kuma의 아키텍처가 어떻게 생겼는지를 다뤄볼게요. 결론부터 말씀드리면, 이 선택의 가장 큰 배경은 **저희 사내 시스템이 IaaS 기반 아키텍처 위에서 운영되고 있었다**는 전제 때문이었어요.

---

## 1. "Kubernetes 네이티브"가 우리에게 안 맞았던 이유

서비스 메시를 검색하면 가장 먼저 나오는 이름은 아마 **Istio**일 거예요. 실제로 기능이나 생태계 면에서 매우 강력한 솔루션이지만, Istio를 비롯한 상당수의 메시 솔루션은 **Kubernetes를 1급 시민으로 전제**하고 설계돼 있어요.

- 사이드카 자동 주입이 k8s의 Mutating Admission Webhook에 의존
- 정책도 대부분 k8s CRD(Custom Resource Definition)로 정의
- VM 기반 워크로드 지원은 "된다"고는 하지만 부가 기능에 가깝고, 설정이 상당히 번거로움

문제는 저희 시스템이 **IaaS 기반**, 즉 VM 단위로 서비스를 운영하는 영역이 상당 부분 남아있는 구조였다는 점이에요. 모든 걸 한 번에 컨테이너/Kubernetes로 옮기는 건 현실적으로 큰 리스크와 비용이 드는 작업이라, "지금 있는 VM 워크로드를 그대로 두고도 메시에 편입시킬 수 있는가"가 사실상 가장 중요한 선택 기준이었어요.

이 지점에서 **Kuma**가 눈에 띄었어요. Kuma는 처음 설계될 때부터 Kubernetes 모드와 더불어 **Universal 모드**를 동등한 1급 시민으로 지원하도록 만들어졌거든요.

---

## 2. Kuma의 기본 구성 요소

Kuma도 다른 서비스 메시와 마찬가지로 컨트롤 플레인/데이터 플레인 구조예요.

| 구성 요소 | 설명 |
| --- | --- |
| `kuma-cp` (컨트롤 플레인) | 정책 저장·배포, xDS 서버로 Envoy에 설정 전달, 서비스 디스커버리 |
| `kuma-dp` + Envoy (데이터 플레인) | 각 서비스 옆에 붙는 사이드카. 실제 트래픽 처리 담당 |
| Dataplane 리소스 | "이 인스턴스가 메시의 일원"임을 컨트롤 플레인에 등록하는 단위 |

여기까지는 다른 메시들과 크게 다르지 않은데, Kuma가 다른 건 이 구성 요소들을 **어떤 플랫폼 위에서도 동일하게** 띄울 수 있게 만들었다는 점이에요.

### Kubernetes 모드
컨테이너 환경에서는 익숙한 방식이에요. Pod가 뜰 때 Mutating Webhook이 `kuma-dp` 사이드카 컨테이너를 자동으로 주입하고, 정책은 k8s 커스텀 리소스(YAML)로 `kubectl apply`하면 됩니다.

### Universal 모드
IaaS/VM 환경에서는 이 모드를 씁니다. 각 VM에 `kuma-dp` 바이너리를 직접 설치해서 서비스와 나란히 실행시키고, 발급받은 **Dataplane 토큰**으로 컨트롤 플레인에 자신을 등록해요. 컨트롤 플레인은 별도의 저장소(Postgres 등)에 상태를 저장하기 때문에 k8s API 서버 없이도 완전히 독립적으로 동작합니다.

![Kuma Universal 모드 아키텍처 - VM에 설치된 kuma-dp가 kuma-cp에 직접 등록되는 구조](/images/service-mesh/universal-mode-architecture.png)

덕분에 기존 VM 위에서 돌아가던 서비스를 코드 변경 없이, 배포 파이프라인에 `kuma-dp` 설치 단계만 추가해서 메시에 편입시킬 수 있었어요. 이게 저희가 Kuma를 선택한 가장 결정적인 이유였습니다.

---

## 3. 멀티존 구조: Zone CP와 Global CP

IaaS 환경은 보통 여러 가용 영역(AZ)이나 데이터센터에 걸쳐 인스턴스가 흩어져 있죠. Kuma는 이런 구조를 위해 **Global CP / Zone CP**라는 2단 구조를 지원해요.

- **Global CP**: 정책의 단일 진실 공급원(source of truth). 메시 정책을 여기 한 곳에만 선언
- **Zone CP**: 각 영역/데이터센터마다 하나씩 떠서, 그 안의 로컬 Dataplane들을 관리. Global CP와 동기화하며 정책을 전달받음

![Zone CP / Global CP 멀티존 구조 - 정책은 Global CP에서 중앙 관리, 트래픽 처리는 각 Zone에서 로컬로 처리](/images/service-mesh/zone-global-cp.png)

이 구조 덕분에 정책은 한 곳에서 중앙 관리하면서도, 실제 트래픽 라우팅 결정은 각 Zone 안에서 로컬로 처리돼서 존 간 네트워크 장애가 다른 존에 영향을 주지 않아요. 여러 가용 영역에 걸쳐 있는 IaaS 인프라 구조와 궁합이 잘 맞았던 부분이에요.

---

## 4. 정책은 선언적으로 - 몇 가지 예시

Kuma의 정책들은 대부분 YAML로 선언해요. 예를 들어 두 서비스 간 통신을 mTLS로 강제하고 싶다면 이런 식이에요. (실제 저희 정책이 아닌 개념 설명용 예시입니다)

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshMTLS
metadata:
  name: mtls-strict
spec:
  targetRef:
    kind: Mesh
  default:
    backends:
      - name: ca-1
        type: builtin
    mode: STRICT
```

특정 서비스만 통신을 허용하는 정책도 비슷하게 선언적으로 표현돼요.

```yaml
apiVersion: kuma.io/v1alpha1
kind: MeshTrafficPermission
metadata:
  name: allow-order-to-payment
spec:
  targetRef:
    kind: MeshService
    name: payment-service
  from:
    - targetRef:
        kind: MeshService
        name: order-service
      default:
        action: Allow
```

이런 정책들이 Global CP에 적용되면 관련된 모든 Zone의 Dataplane에 자동으로 전파돼요. 서비스 코드는 전혀 건드릴 필요가 없죠.

---

## 정리

- 사내 시스템이 **IaaS(VM) 기반**이라는 전제 때문에, Kubernetes 전용 설계인 솔루션들은 도입 장벽이 높았어요.
- Kuma의 **Universal 모드**는 k8s 없이도 컨트롤 플레인/데이터 플레인이 동작해서, 기존 VM 워크로드를 그대로 메시에 편입시킬 수 있었어요.
- **Zone/Global CP** 2단 구조가 여러 가용 영역에 걸친 IaaS 인프라와 잘 맞아떨어졌어요.
- 정책은 전부 선언적 YAML이라 서비스 코드를 건드리지 않고도 중앙에서 관리할 수 있어요.

## 다음 편 예고

**3편: Kuma 기반 서비스 메시 구축기**에서는 실제로 트래픽 정책(재시도·타임아웃·서킷 브레이커)과 카나리 배포를 어떤 방식으로 설계했는지를 다뤄볼게요.

#서비스메시 #ServiceMesh #Kuma #Envoy #IaaS #멀티존 #인프라 #DevOps
