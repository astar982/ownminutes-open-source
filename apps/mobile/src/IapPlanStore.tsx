import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { deepLinkToSubscriptions, useIAP, type Purchase, type PurchaseError } from "expo-iap";
import type { TranslateOptions } from "i18n-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { fetchAppleAccountToken, fetchPaymentStorefront, submitAppleTransaction } from "./api";
import { createIapTransactionCoordinator } from "./iap-transaction-coordinator";
import { useI18n } from "./i18n/provider";
import type { AppleTransactionResponse, BillingPlanId, MobileUser, PaymentStorefront } from "./types";

type ProductDefinition = {
  plan: BillingPlanId;
  productId: string;
};

type IapPlanStoreProps = {
  apiBaseUrl: string;
  authCookie: string;
  currentUser: MobileUser;
  onEntitlementUpdated: (user: MobileUser) => Promise<void> | void;
  onError: (message: string) => void;
};

type IapPlanStoreProviderProps = {
  children: ReactNode;
  session: IapPlanStoreProps | null;
};

type TransactionCandidate = {
  productId: string;
  purchase?: Purchase;
  showSuccessAlert: boolean;
  transactionId: string;
};

const fallbackPlans: ProductDefinition[] = [
  { plan: "plus", productId: "ownminutes.plus.monthly" },
  { plan: "pro", productId: "ownminutes.pro.monthly" },
];

const planMetadata: Record<BillingPlanId, { captionKey: string; minutes: number; name: string; priceKey: string }> = {
  free: { captionKey: "iap.freeCaption", minutes: 60, name: "Free", priceKey: "iap.freePrice" },
  plus: { captionKey: "iap.plusCaption", minutes: 600, name: "Plus", priceKey: "iap.storePrice" },
  pro: { captionKey: "iap.proCaption", minutes: 1800, name: "Pro", priceKey: "iap.storePrice" },
};

const IapPlanStoreViewContext = createContext<ReactNode>(null);

export function IapPlanStoreProvider({ children, session }: IapPlanStoreProviderProps) {
  if (!session) {
    return <IapPlanStoreViewContext.Provider value={null}>{children}</IapPlanStoreViewContext.Provider>;
  }

  const isExpoGo = Constants.appOwnership === "expo";
  if (Platform.OS !== "ios" || isExpoGo) {
    const unavailableView = (
      <UnavailablePlanStore
        {...session}
        reasonKey={Platform.OS !== "ios" ? "iap.iphoneOnly" : "iap.expoGoUnsupported"}
      />
    );
    return <IapPlanStoreViewContext.Provider value={unavailableView}>{children}</IapPlanStoreViewContext.Provider>;
  }

  const sessionKey = `${session.apiBaseUrl}\u0000${session.authCookie}\u0000${session.currentUser.id}`;
  return (
    <NativeIapPlanStoreProvider key={sessionKey} {...session}>
      {children}
    </NativeIapPlanStoreProvider>
  );
}

export function IapPlanStore() {
  return useContext(IapPlanStoreViewContext);
}

function NativeIapPlanStoreProvider({
  apiBaseUrl,
  authCookie,
  children,
  currentUser,
  onEntitlementUpdated,
  onError,
}: IapPlanStoreProps & { children: ReactNode }) {
  const { locale, t } = useI18n();
  const tRef = useRef(t);
  const [storefront, setStorefront] = useState<PaymentStorefront | null>(null);
  const [definitions, setDefinitions] = useState<ProductDefinition[]>(fallbackPlans);
  const [statusKey, setStatusKey] = useState("iap.connectingStore");
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(true);
  const [purchasingPlan, setPurchasingPlan] = useState<BillingPlanId | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreCompleted, setRestoreCompleted] = useState(false);
  const [checkingSubscriptionStatus, setCheckingSubscriptionStatus] = useState(false);
  const [subscriptionStatusChecked, setSubscriptionStatusChecked] = useState(false);
  const [managingSubscription, setManagingSubscription] = useState(false);
  const [appAccountBinding, setAppAccountBinding] = useState<{ key: string; token: string } | null>(null);
  const coordinatorRef = useRef(createIapTransactionCoordinator<AppleTransactionResponse>());
  const syncedActiveTransactionsRef = useRef(new Set<string>());
  const fetchedProductsRef = useRef("");
  const mountedRef = useRef(true);
  const pendingPurchaseEventsRef = useRef<Purchase[]>([]);
  const processCandidateRef = useRef<((candidate: TransactionCandidate) => Promise<void>) | null>(null);
  const replayQueryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeReconnectRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttemptsRef = useRef(new Map<string, number>());
  const retryCandidatesRef = useRef(new Map<string, TransactionCandidate>());
  const retryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const successAlertsRef = useRef(new Set<string>());

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const {
    activeSubscriptions,
    availablePurchases,
    connected,
    fetchProducts,
    finishTransaction,
    getActiveSubscriptions,
    getAvailablePurchases,
    reconnect,
    requestPurchase,
    restorePurchases,
    subscriptions,
  } = useIAP({
    onError: (error) => setStatusKey(friendlyStoreErrorKey(error)),
    onPurchaseError: (error) => {
      setPurchasingPlan(null);
      if (!isUserCancellation(error)) {
        const key = friendlyStoreErrorKey(error);
        setStatusKey(key);
        onError(tRef.current(key));
      }
    },
    onPurchaseSuccess: (purchase) => {
      const handler = processCandidateRef.current;
      const transactionId = purchase.transactionId || purchase.id;
      if (!handler || !transactionId) {
        pendingPurchaseEventsRef.current.push(purchase);
        return;
      }
      void handler({
        productId: purchase.productId,
        purchase,
        showSuccessAlert: true,
        transactionId,
      });
    },
  });

  useEffect(() => () => {
    mountedRef.current = false;
    if (replayQueryRetryTimerRef.current) {
      clearTimeout(replayQueryRetryTimerRef.current);
      replayQueryRetryTimerRef.current = null;
    }
    if (storeReconnectRetryTimerRef.current) {
      clearTimeout(storeReconnectRetryTimerRef.current);
      storeReconnectRetryTimerRef.current = null;
    }
    for (const timer of retryTimersRef.current.values()) clearTimeout(timer);
    retryTimersRef.current.clear();
    retryCandidatesRef.current.clear();
  }, []);

  useEffect(() => {
    if (connected) return;
    let cancelled = false;
    let reconnectFailures = 0;

    const reconnectStore = async () => {
      const reconnected = await reconnect();
      if (cancelled || reconnected) return;
      const delayMs = [5_000, 15_000, 60_000][Math.min(reconnectFailures, 2)];
      reconnectFailures += 1;
      storeReconnectRetryTimerRef.current = setTimeout(() => {
        storeReconnectRetryTimerRef.current = null;
        void reconnectStore();
      }, delayMs);
    };

    storeReconnectRetryTimerRef.current = setTimeout(() => {
      storeReconnectRetryTimerRef.current = null;
      void reconnectStore();
    }, 5_000);
    return () => {
      cancelled = true;
      if (storeReconnectRetryTimerRef.current) {
        clearTimeout(storeReconnectRetryTimerRef.current);
        storeReconnectRetryTimerRef.current = null;
      }
    };
  }, [connected, reconnect]);

  const serverReady =
    storefront?.acceptingPurchases === true &&
    storefront.provider.id === "apple-iap" &&
    storefront.provider.status === "available" &&
    storefront.products.length > 0;
  const appAccountBindingKey = `${apiBaseUrl}\u0000${authCookie}\u0000${currentUser.id}`;
  const appAccountToken =
    serverReady && appAccountBinding?.key === appAccountBindingKey
      ? appAccountBinding.token
      : "";

  const productById = useMemo(() => new Map(subscriptions.map((item) => [item.id, item])), [subscriptions]);

  useEffect(() => {
    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const loadStorefront = async () => {
      try {
        const result = await fetchPaymentStorefront(apiBaseUrl, authCookie);
        if (cancelled) return;
        setStorefront(result);
        setDefinitions(result.products.length
          ? result.products
              .filter((item) => item.plan === "plus" || item.plan === "pro")
              .map(({ plan, productId }) => ({ plan, productId }))
          : fallbackPlans);
        failures = 0;
      } catch {
        if (cancelled) return;
        setStorefront(null);
        setStatusKey("iap.diagnosticsFailed");
        if (failures === 0) onError(tRef.current("iap.diagnosticsFailed"));
        const delayMs = [5_000, 15_000, 60_000][Math.min(failures, 2)];
        failures += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadStorefront();
        }, delayMs);
      } finally {
        if (!cancelled) setLoadingDiagnostics(false);
      }
    };

    void loadStorefront();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [apiBaseUrl, authCookie, onError]);

  useEffect(() => {
    if (!serverReady) return;
    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const loadAccountBinding = async () => {
      try {
        const token = await fetchAppleAccountToken(apiBaseUrl, authCookie);
        if (!cancelled) setAppAccountBinding({ key: appAccountBindingKey, token });
        failures = 0;
      } catch {
        if (cancelled) return;
        setStatusKey("iap.accountBindingFailed");
        if (failures === 0) onError(tRef.current("iap.accountBindingFailed"));
        const delayMs = [5_000, 15_000, 60_000][Math.min(failures, 2)];
        failures += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadAccountBinding();
        }, delayMs);
      }
    };

    void loadAccountBinding();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [apiBaseUrl, appAccountBindingKey, authCookie, onError, serverReady]);

  useEffect(() => {
    if (!connected || !serverReady || definitions.length === 0) return;
    const key = definitions.map((item) => item.productId).sort().join("|");
    if (fetchedProductsRef.current === key) return;
    fetchedProductsRef.current = key;
    setStatusKey("iap.readingProducts");
    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const skus = definitions.map((item) => item.productId);

    const loadProducts = async () => {
      try {
        await fetchProducts({ skus, type: "subs" });
        if (!cancelled) setStatusKey("iap.storeConnected");
      } catch (error) {
        if (cancelled) return;
        fetchedProductsRef.current = "";
        setStatusKey(friendlyStoreErrorKey(error));
        const delayMs = [5_000, 15_000, 60_000][Math.min(failures, 2)];
        failures += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          fetchedProductsRef.current = key;
          void loadProducts();
        }, delayMs);
      }
    };

    void loadProducts();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [connected, definitions, fetchProducts, serverReady]);

  useEffect(() => {
    if (!connected || definitions.length === 0) return;

    let cancelled = false;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const productIds = definitions.map((item) => item.productId);

    const loadActiveSubscriptions = async () => {
      if (cancelled) return;
      setCheckingSubscriptionStatus(true);
      try {
        await getActiveSubscriptions(productIds);
        failures = 0;
      } catch {
        if (cancelled) return;
        setStatusKey("iap.subscriptionStatusFailed");
        const delayMs = [5_000, 15_000, 60_000][Math.min(failures, 2)];
        failures += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loadActiveSubscriptions();
        }, delayMs);
      } finally {
        if (cancelled) return;
        setCheckingSubscriptionStatus(false);
        setSubscriptionStatusChecked(true);
      }
    };

    void Promise.resolve().then(loadActiveSubscriptions);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [connected, definitions, getActiveSubscriptions]);

  const scheduleCandidateRetry = useCallback((candidate: TransactionCandidate) => {
    if (!mountedRef.current) return;
    const transactionId = candidate.transactionId;
    const existing = retryCandidatesRef.current.get(transactionId);
    retryCandidatesRef.current.set(transactionId, {
      ...existing,
      ...candidate,
      purchase: candidate.purchase ?? existing?.purchase,
      showSuccessAlert: candidate.showSuccessAlert || existing?.showSuccessAlert === true,
    });
    if (retryTimersRef.current.has(transactionId)) return;

    const attempt = retryAttemptsRef.current.get(transactionId) ?? 0;
    const delayMs = [5_000, 15_000, 60_000][Math.min(attempt, 2)];
    retryAttemptsRef.current.set(transactionId, attempt + 1);
    const timer = setTimeout(() => {
      retryTimersRef.current.delete(transactionId);
      const pending = retryCandidatesRef.current.get(transactionId);
      if (!pending || !mountedRef.current) return;
      void processCandidateRef.current?.(pending);
    }, delayMs);
    retryTimersRef.current.set(transactionId, timer);
  }, []);

  const processCandidate = useCallback(
    async (candidate: TransactionCandidate) => {
      if (!candidate.transactionId) return;
      if (mountedRef.current) setStatusKey("iap.validatingTransaction");
      try {
        const result = await coordinatorRef.current.run({
          transactionId: candidate.transactionId,
          verify: () => submitAppleTransaction({
            apiBaseUrl,
            authCookie,
            productId: candidate.productId,
            transactionId: candidate.transactionId,
          }),
          apply: async (verified) => {
            const user = verified.user;
            if (!user) throw new Error("IAP_ENTITLEMENT_MISSING");
            if (!mountedRef.current) return;
            await onEntitlementUpdated(user);
          },
          finish: candidate.purchase
            ? () => finishTransaction({ purchase: candidate.purchase as Purchase, isConsumable: false })
            : undefined,
        });
        const user = result.user;
        if (!user) throw new Error("IAP_ENTITLEMENT_MISSING");
        const retryTimer = retryTimersRef.current.get(candidate.transactionId);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimersRef.current.delete(candidate.transactionId);
        retryCandidatesRef.current.delete(candidate.transactionId);
        retryAttemptsRef.current.delete(candidate.transactionId);
        if (!mountedRef.current) return;
        setStatusKey(result.duplicate ? "iap.purchaseRestored" : "iap.purchaseSucceeded");
        if (candidate.showSuccessAlert && !successAlertsRef.current.has(candidate.transactionId)) {
          successAlertsRef.current.add(candidate.transactionId);
          Alert.alert(
            t("iap.updatedTitle"),
            t("iap.updatedBody", { plan: user.plan.toUpperCase(), minutes: user.officialMinutesTotal }),
          );
        }
      } catch (error) {
        if (!mountedRef.current) return;
        const firstFailure = !retryAttemptsRef.current.has(candidate.transactionId);
        const key = error instanceof Error && error.message === "IAP_ENTITLEMENT_MISSING"
          ? "iap.entitlementMissing"
          : "iap.transactionFailed";
        setStatusKey("iap.transactionFailedRetry");
        if (candidate.showSuccessAlert && firstFailure) onError(t(key));
        if (isRetryableIapTransactionError(error)) scheduleCandidateRetry(candidate);
      } finally {
        if (candidate.purchase && mountedRef.current) setPurchasingPlan(null);
      }
    },
    [apiBaseUrl, authCookie, finishTransaction, onEntitlementUpdated, onError, scheduleCandidateRetry, t],
  );

  useEffect(() => {
    processCandidateRef.current = processCandidate;
    const pending = pendingPurchaseEventsRef.current.splice(0);
    for (const purchase of pending) {
      const transactionId = purchase.transactionId || purchase.id;
      if (!transactionId) continue;
      void processCandidate({
        productId: purchase.productId,
        purchase,
        showSuccessAlert: true,
        transactionId,
      });
    }
    return () => {
      processCandidateRef.current = null;
    };
  }, [processCandidate]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let queryFailures = 0;

    const queryUnfinishedPurchases = async () => {
      try {
        await getAvailablePurchases({
          alsoPublishToEventListenerIOS: false,
          onlyIncludeActiveItemsIOS: true,
        });
        queryFailures = 0;
      } catch {
        if (cancelled || !mountedRef.current) return;
        const delayMs = [5_000, 15_000, 60_000][Math.min(queryFailures, 2)];
        queryFailures += 1;
        replayQueryRetryTimerRef.current = setTimeout(() => {
          replayQueryRetryTimerRef.current = null;
          void queryUnfinishedPurchases();
        }, delayMs);
      }
    };

    void queryUnfinishedPurchases();
    return () => {
      cancelled = true;
      if (replayQueryRetryTimerRef.current) {
        clearTimeout(replayQueryRetryTimerRef.current);
        replayQueryRetryTimerRef.current = null;
      }
    };
  }, [connected, getAvailablePurchases]);

  useEffect(() => {
    const eligible = availablePurchases.filter((purchase) =>
      definitions.some((item) => item.productId === purchase.productId),
    );
    for (const purchase of eligible) {
      const transactionId = purchase.transactionId || purchase.id;
      if (!transactionId) continue;
      void Promise.resolve().then(() =>
        processCandidate({
          productId: purchase.productId,
          purchase,
          showSuccessAlert: false,
          transactionId,
        }),
      );
    }
  }, [availablePurchases, definitions, processCandidate]);

  useEffect(() => {
    if (!restoreCompleted) return;
    void Promise.resolve().then(async () => {
      setRestoreCompleted(false);
      const eligible = availablePurchases.filter((purchase) => definitions.some((item) => item.productId === purchase.productId));
      if (eligible.length === 0) {
        setStatusKey("iap.noRestorableSubscription");
        setSubscriptionStatusChecked(true);
        setRestoring(false);
        return;
      }
      await eligible.reduce<Promise<void>>(async (previous, purchase) => {
        await previous;
        const transactionId = purchase.transactionId || purchase.id;
        if (!transactionId) return;
        await processCandidate({
          productId: purchase.productId,
          purchase,
          showSuccessAlert: true,
          transactionId,
        });
      }, Promise.resolve());
      await getActiveSubscriptions(definitions.map((item) => item.productId)).catch(() => undefined);
      setSubscriptionStatusChecked(true);
      setRestoring(false);
    });
  }, [availablePurchases, definitions, getActiveSubscriptions, processCandidate, restoreCompleted]);

  async function purchase(plan: BillingPlanId, productId: string) {
    if (!connected || !serverReady || !appAccountToken || !productById.has(productId)) return;
    setPurchasingPlan(plan);
    setStatusKey("iap.waitingForConfirmation");
    try {
      await requestPurchase({ request: { apple: { appAccountToken, sku: productId } }, type: "subs" });
    } catch (error) {
      setPurchasingPlan(null);
      const key = friendlyStoreErrorKey(error);
      setStatusKey(key);
      if (!isUserCancellation(error)) onError(t(key));
    }
  }

  async function restore() {
    if (!connected || !serverReady || restoring) return;
    setRestoring(true);
    setRestoreCompleted(false);
    setSubscriptionStatusChecked(false);
    setStatusKey("iap.syncingPurchases");
    try {
      await restorePurchases({ alsoPublishToEventListenerIOS: true, onlyIncludeActiveItemsIOS: true });
      await getActiveSubscriptions(definitions.map((item) => item.productId)).catch(() => undefined);
      setRestoreCompleted(true);
    } catch (error) {
      const key = friendlyStoreErrorKey(error);
      setStatusKey(key);
      onError(t(key));
      setRestoring(false);
    }
  }

  async function manageSubscription() {
    if (managingSubscription) return;
    setManagingSubscription(true);
    try {
      await deepLinkToSubscriptions();
    } catch {
      setStatusKey("iap.manageSubscriptionFailed");
      onError(t("iap.manageSubscriptionFailed"));
    } finally {
      setManagingSubscription(false);
    }
  }

  async function openLegalPage(path: "/privacy" | "/terms") {
    try {
      await Linking.openURL(`${apiBaseUrl.replace(/\/$/, "")}${localizedLegalPagePath(locale, path)}`);
    } catch {
      onError(t("iap.legalLinkFailed"));
    }
  }

  const unavailableReason = paymentUnavailableReason({ connected, loadingDiagnostics, serverReady, storefront }, t) || (!appAccountToken ? t("iap.bindingAccount") : "");
  const statusMessage = t(statusKey);
  const activeSubscription = activeSubscriptions.find(
    (subscription) => subscription.isActive && definitions.some((item) => item.productId === subscription.productId),
  );
  const activeDefinition = activeSubscription ? definitions.find((item) => item.productId === activeSubscription.productId) : undefined;
  useEffect(() => {
    const transactionId = activeSubscription?.transactionId;
    if (!serverReady || !transactionId || !activeDefinition || currentUser.plan === activeDefinition.plan) return;
    if (syncedActiveTransactionsRef.current.has(transactionId)) return;
    syncedActiveTransactionsRef.current.add(transactionId);
    void processCandidate({
      productId: activeSubscription.productId,
      showSuccessAlert: false,
      transactionId,
    });
  }, [activeDefinition, activeSubscription, currentUser.plan, processCandidate, serverReady]);
  const expirationDate = activeSubscription?.expirationDateIOS ? formatSubscriptionDate(activeSubscription.expirationDateIOS, locale) : "";
  const subscriptionStatusMessage = !connected
    ? t("iap.restoreHint")
    : checkingSubscriptionStatus
      ? t("iap.checkingSubscriptionStatus")
      : activeSubscription
        ? expirationDate
          ? activeSubscription.renewalInfoIOS?.willAutoRenew === true
            ? t("iap.activeSubscriptionRenews", { date: expirationDate, plan: activeDefinition?.plan.toUpperCase() || "APPLE" })
            : t("iap.activeSubscriptionUntil", { date: expirationDate, plan: activeDefinition?.plan.toUpperCase() || "APPLE" })
          : t("iap.activeSubscription", { plan: activeDefinition?.plan.toUpperCase() || "APPLE" })
        : subscriptionStatusChecked
          ? t("iap.noActiveSubscription")
          : t("iap.restoreHint");

  const storeView = (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.title}>{t("iap.title")}</Text>
          <Text style={styles.subtitle}>{t("iap.subtitle")}</Text>
        </View>
        <View style={[styles.statusPill, serverReady && connected ? styles.statusPillReady : null]}>
          <Text style={[styles.statusText, serverReady && connected ? styles.statusTextReady : null]}>{serverReady && connected ? "App Store" : t("iap.unavailableStatus")}</Text>
        </View>
      </View>

      <PlanCard active={currentUser.plan === "free"} caption={t(planMetadata.free.captionKey)} minutes={planMetadata.free.minutes} name="Free" price={t(planMetadata.free.priceKey)} />
      {definitions.map((definition) => {
        const meta = planMetadata[definition.plan];
        const storeProduct = productById.get(definition.productId);
        const active = currentUser.plan === definition.plan;
        const disabled = active || Boolean(unavailableReason) || !storeProduct || purchasingPlan !== null;
        return (
          <PlanCard
            key={definition.productId}
            active={active}
            caption={t(meta.captionKey)}
            disabled={disabled}
            disabledLabel={serverReady ? t("purchaseState.waiting") : t("purchaseState.notOpen")}
            loading={purchasingPlan === definition.plan}
            minutes={meta.minutes}
            name={meta.name}
            onPress={() => void purchase(definition.plan, definition.productId)}
            price={storeProduct?.displayPrice || t(meta.priceKey)}
            recurring
          />
        );
      })}

      <View style={styles.disclosureCard}>
        <Text style={styles.disclosureTitle}>{t("iap.autoRenewTitle")}</Text>
        <Text style={styles.disclosureText}>{t("iap.autoRenewDisclosure")}</Text>
        <View style={styles.legalLinks}>
          <Pressable accessibilityRole="link" onPress={() => void openLegalPage("/terms")} style={styles.legalLinkButton}>
            <Text style={styles.legalLink}>{t("iap.termsOfUse")}</Text>
          </Pressable>
          <Text style={styles.legalSeparator}>·</Text>
          <Pressable accessibilityRole="link" onPress={() => void openLegalPage("/privacy")} style={styles.legalLinkButton}>
            <Text style={styles.legalLink}>{t("iap.privacyPolicy")}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.noticeRow}>
        {loadingDiagnostics || (serverReady && !connected) ? <ActivityIndicator color="#1b6b4a" size="small" /> : <Ionicons accessibilityElementsHidden color={unavailableReason ? "#9a6d35" : "#1b6b4a"} name={unavailableReason ? "information-circle-outline" : "shield-checkmark-outline"} size={18} />}
        <Text accessibilityLiveRegion="polite" style={unavailableReason ? styles.warning : styles.help}>{unavailableReason || statusMessage}</Text>
      </View>

      <View accessible accessibilityLabel={subscriptionStatusMessage} style={styles.subscriptionStatus}>
        {checkingSubscriptionStatus ? (
          <ActivityIndicator color="#1b6b4a" size="small" />
        ) : (
          <Ionicons accessibilityElementsHidden color={activeSubscription ? "#1b6b4a" : "#66726b"} name={activeSubscription ? "checkmark-circle-outline" : "information-circle-outline"} size={18} />
        )}
        <Text accessibilityLiveRegion="polite" style={activeSubscription ? styles.help : styles.subscriptionStatusText}>{subscriptionStatusMessage}</Text>
      </View>

      <Pressable accessibilityLabel={t("iap.restorePurchase")} accessibilityRole="button" accessibilityState={{ disabled: !serverReady || !connected || restoring }} disabled={!serverReady || !connected || restoring} onPress={() => void restore()} style={({ pressed }) => [styles.restoreButton, (!serverReady || !connected || restoring) && styles.disabled, pressed && styles.pressed]}>
        {restoring ? <ActivityIndicator color="#1b6b4a" size="small" /> : <Ionicons accessibilityElementsHidden color="#1b6b4a" name="refresh" size={18} />}
        <Text style={styles.restoreText}>{restoring ? t("iap.restoring") : t("iap.restorePurchase")}</Text>
      </Pressable>
      <Pressable accessibilityLabel={t("iap.manageSubscription")} accessibilityRole="button" accessibilityState={{ disabled: managingSubscription }} disabled={managingSubscription} onPress={() => void manageSubscription()} style={({ pressed }) => [styles.manageButton, managingSubscription && styles.disabled, pressed && styles.pressed]}>
        {managingSubscription ? <ActivityIndicator color="#1b6b4a" size="small" /> : <Ionicons accessibilityElementsHidden color="#1b6b4a" name="open-outline" size={18} />}
        <Text style={styles.restoreText}>{t("iap.manageSubscription")}</Text>
      </Pressable>
    </View>
  );
  return <IapPlanStoreViewContext.Provider value={storeView}>{children}</IapPlanStoreViewContext.Provider>;
}

function UnavailablePlanStore({ currentUser, reasonKey }: IapPlanStoreProps & { reasonKey: string }) {
  const { t } = useI18n();
  const reason = t(reasonKey);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View>
          <Text style={styles.title}>{t("iap.title")}</Text>
          <Text style={styles.subtitle}>{t("iap.subtitle")}</Text>
        </View>
        <View style={styles.statusPill}>
          <Text style={styles.statusText}>{t("iap.previewMode")}</Text>
        </View>
      </View>
      <PlanCard active={currentUser.plan === "free"} caption={t(planMetadata.free.captionKey)} minutes={planMetadata.free.minutes} name="Free" price={t(planMetadata.free.priceKey)} />
      {fallbackPlans.map((item) => {
        const meta = planMetadata[item.plan];
        return <PlanCard key={item.productId} active={currentUser.plan === item.plan} caption={t(meta.captionKey)} disabled disabledLabel={t("purchaseState.notOpen")} minutes={meta.minutes} name={meta.name} price={t(meta.priceKey)} recurring />;
      })}
      <View style={styles.noticeRow}>
        <Ionicons accessibilityElementsHidden color="#9a6d35" name="information-circle-outline" size={18} />
        <Text style={styles.warning}>{t("iap.unavailableFreeDetail", { reason })}</Text>
      </View>
    </View>
  );
}

function PlanCard({ active, caption, disabled, disabledLabel, loading, minutes, name, onPress, price, recurring }: { active: boolean; caption: string; disabled?: boolean; disabledLabel?: string; loading?: boolean; minutes: number; name: string; onPress?: () => void; price: string; recurring?: boolean }) {
  const { t } = useI18n();
  return (
    <Pressable accessibilityLabel={t(recurring ? "iap.planAccessibilityRecurring" : "iap.planAccessibility", { name, price, minutes })} accessibilityRole="button" accessibilityState={{ disabled: disabled || !onPress, selected: active }} disabled={disabled || !onPress} onPress={onPress} style={({ pressed }) => [styles.plan, active ? styles.planActive : null, disabled && !active ? styles.disabled : null, pressed ? styles.pressed : null]}>
      <View style={styles.planTop}>
        <View>
          <Text style={styles.planName}>{name}</Text>
          <Text style={styles.planCaption}>{caption}</Text>
        </View>
        <View style={active ? styles.activeBadge : styles.chooseBadge}>
          <Text style={active ? styles.activeBadgeText : styles.chooseBadgeText}>{active ? t("iap.currentPlan") : loading ? t("iap.processing") : disabled ? disabledLabel || t("purchaseState.waiting") : t("iap.choose")}</Text>
        </View>
      </View>
      <View style={styles.planBottom}>
        <View>
          <Text style={styles.price}>{price}</Text>
          {recurring ? <Text style={styles.billingPeriod}>{t("iap.perMonth")}</Text> : null}
        </View>
        <Text style={styles.minutes}>{t(recurring ? "iap.officialMinutesPerMonth" : "iap.officialMinutes", { minutes })}</Text>
      </View>
    </Pressable>
  );
}

function paymentUnavailableReason(input: { connected: boolean; loadingDiagnostics: boolean; serverReady: boolean; storefront: PaymentStorefront | null }, t: Translate) {
  if (input.loadingDiagnostics) return t("iap.checkingPayment");
  if (!input.storefront) return t("purchaseState.notOpenDetail");
  if (!input.serverReady) return t("iap.iapNotConfigured");
  if (!input.connected) return t("iap.connectingWait");
  return null;
}

function formatSubscriptionDate(timestamp: number, locale: "en" | "zh-Hans" | "zh-Hant") {
  const languageTag = locale === "zh-Hans" ? "zh-CN" : locale === "zh-Hant" ? "zh-TW" : "en-US";
  return new Intl.DateTimeFormat(languageTag, { day: "numeric", month: "short", year: "numeric" }).format(new Date(timestamp));
}

function localizedLegalPagePath(locale: "en" | "zh-Hans" | "zh-Hant", path: "/privacy" | "/terms") {
  if (locale === "en") return `/en${path}`;
  if (locale === "zh-Hant") return `/zh-Hant${path}`;
  return path;
}

type Translate = (key: string, options?: TranslateOptions) => string;

function friendlyStoreErrorKey(error: unknown) {
  return isUserCancellation(error) ? "iap.purchaseCancelled" : "iap.storeUnavailable";
}

function isUserCancellation(error: unknown) {
  const candidate = error as Partial<PurchaseError> | null;
  const code = String(candidate?.code || "").toLowerCase();
  const message = String(candidate?.message || "").toLowerCase();
  return code.includes("cancel") || message.includes("cancel") || message.includes("取消");
}

function isRetryableIapTransactionError(error: unknown) {
  const candidate = error as {
    httpStatus?: unknown;
    retryable?: unknown;
    status?: unknown;
  } | null;
  if (candidate?.retryable === true) return true;
  const status = Number(candidate?.status ?? candidate?.httpStatus ?? 0);
  return !Number.isFinite(status) || status === 0 || status === 408 || status === 429 || status >= 500;
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 18 },
  sectionHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  title: { color: "#17201b", fontSize: 18, fontWeight: "700" },
  subtitle: { color: "#66726b", fontSize: 13, marginTop: 3 },
  statusPill: { backgroundColor: "#f4eee4", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  statusPillReady: { backgroundColor: "#e6f2eb" },
  statusText: { color: "#8b6841", fontSize: 12, fontWeight: "700" },
  statusTextReady: { color: "#1b6b4a" },
  plan: { backgroundColor: "#fbfaf7", borderColor: "#e6e1d7", borderRadius: 8, borderWidth: 1, gap: 14, padding: 15 },
  planActive: { backgroundColor: "#f0f7f3", borderColor: "#1b6b4a" },
  planTop: { alignItems: "flex-start", flexDirection: "row", gap: 12, justifyContent: "space-between" },
  planName: { color: "#17201b", fontSize: 17, fontWeight: "700" },
  planCaption: { color: "#66726b", fontSize: 13, marginTop: 4 },
  activeBadge: { backgroundColor: "#1b6b4a", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  activeBadgeText: { color: "#ffffff", fontSize: 12, fontWeight: "700" },
  chooseBadge: { backgroundColor: "#ffffff", borderColor: "#d9d3c8", borderRadius: 999, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  chooseBadgeText: { color: "#445149", fontSize: 12, fontWeight: "700" },
  planBottom: { alignItems: "flex-end", flexDirection: "row", justifyContent: "space-between" },
  price: { color: "#17201b", fontSize: 20, fontWeight: "800" },
  billingPeriod: { color: "#66726b", fontSize: 12, marginTop: 2 },
  minutes: { color: "#66726b", fontSize: 13 },
  disclosureCard: { backgroundColor: "#f7f5ef", borderColor: "#e6e1d7", borderRadius: 8, borderWidth: 1, gap: 7, padding: 12 },
  disclosureTitle: { color: "#17201b", fontSize: 13, fontWeight: "700" },
  disclosureText: { color: "#5f6b64", fontSize: 12, lineHeight: 18 },
  legalLinks: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 },
  legalLinkButton: { justifyContent: "center", minHeight: 44 },
  legalLink: { color: "#1b6b4a", fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  legalSeparator: { color: "#9aa39e", fontSize: 12 },
  noticeRow: { alignItems: "flex-start", flexDirection: "row", gap: 8, paddingHorizontal: 2, paddingVertical: 4 },
  subscriptionStatus: { alignItems: "flex-start", backgroundColor: "#f7faf8", borderRadius: 8, flexDirection: "row", gap: 8, padding: 10 },
  subscriptionStatusText: { color: "#66726b", flex: 1, fontSize: 12, lineHeight: 18 },
  help: { color: "#52635a", flex: 1, fontSize: 13, lineHeight: 19 },
  warning: { color: "#8b5f2f", flex: 1, fontSize: 13, lineHeight: 19 },
  restoreButton: { alignItems: "center", alignSelf: "flex-start", borderColor: "#cbd8d0", borderRadius: 8, borderWidth: 1, flexDirection: "row", gap: 7, minHeight: 44, paddingHorizontal: 13 },
  manageButton: { alignItems: "center", alignSelf: "flex-start", borderColor: "#b8d2c3", borderRadius: 8, borderWidth: 1, flexDirection: "row", gap: 7, minHeight: 44, paddingHorizontal: 13 },
  restoreText: { color: "#1b6b4a", fontSize: 14, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.72 },
});
