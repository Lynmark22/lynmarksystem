/* ================================================== */
/* ELECTRIC BILLING SYSTEM LOGIC                      */
/* Specific for Billing Page functionality            */
/* ================================================== */

// Global state
let currentUser = null;
let userProfile = null;
let billingRecords = [];
const CURRENCY_SYMBOL = '\u20B1';

function formatCurrency(amount) {
    const numericAmount = Number(amount) || 0;
    return `${CURRENCY_SYMBOL}${numericAmount.toLocaleString('en-PH', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

// Initialize Supabase
const SUPABASE_URL = 'https://jlbvoiqexugdobzgpvyb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsYnZvaXFleHVnZG9iemdwdnliIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ3NTU1MzAsImV4cCI6MjA4MDMzMTUzMH0.2RVENuR1AVPbjM5vBG7c2_fppn3D4zAZCuBFVCI08SA';
let supabaseClient;
let billingAutoRefreshTimer = null;
let billingRealtimeChannel = null;
let billingRefreshBusy = false;
let billingRealtimeRefreshTimer = null;
let userProfileRefreshAllowed = true;
let lastUserProfileRefreshAt = 0;
const BILLING_AUTO_REFRESH_MS = 10000;
const USER_PROFILE_REFRESH_MS = 30000;
const BILLING_SCROLL_IDLE_MS = 4500;
let lastBillingTableInteractionAt = 0;
const BILLING_RENDER_SIGNATURES = {
    public: '',
    tenant: '',
    admin: ''
};

function registerBillingTableInteraction() {
    lastBillingTableInteractionAt = Date.now();
}

function initBillingTableInteractionTracking() {
    const wrappers = document.querySelectorAll('.billing-table-wrapper');
    wrappers.forEach((wrapper) => {
        if (!(wrapper instanceof HTMLElement)) return;
        wrapper.addEventListener('scroll', registerBillingTableInteraction, { passive: true });
        wrapper.addEventListener('touchstart', registerBillingTableInteraction, { passive: true });
        wrapper.addEventListener('wheel', registerBillingTableInteraction, { passive: true });
    });
}

function captureTableScroll(tbody, preserveScroll = false) {
    if (!preserveScroll || !tbody) {
        return { wrapper: null, scrollTop: 0 };
    }
    const wrapper = tbody.closest('.billing-table-wrapper');
    if (!(wrapper instanceof HTMLElement)) {
        return { wrapper: null, scrollTop: 0 };
    }
    return { wrapper, scrollTop: wrapper.scrollTop };
}

function restoreTableScroll(snapshot) {
    if (!snapshot || !(snapshot.wrapper instanceof HTMLElement)) return;
    const wrapper = snapshot.wrapper;
    const maxScrollTop = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
    wrapper.scrollTop = Math.min(snapshot.scrollTop, maxScrollTop);
}

function makeBillsSignature(rows, fields) {
    if (!Array.isArray(rows) || rows.length === 0) return '[]';
    return JSON.stringify(rows.map((row) => fields.map((field) => row?.[field] ?? null)));
}

function shouldSkipAutoRefreshWhileInteracting(force = false) {
    if (force) return false;
    return Date.now() - lastBillingTableInteractionAt < BILLING_SCROLL_IDLE_MS;
}

function queueRealtimeBillingRefresh(force = false) {
    if (billingRealtimeRefreshTimer) return;
    billingRealtimeRefreshTimer = setTimeout(() => {
        billingRealtimeRefreshTimer = null;
        refreshBillingLiveData(force);
    }, 900);
}

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
    initBillingTableInteractionTracking();
    if (typeof window.supabase !== 'undefined') {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        checkSession();
    } else {
        console.error('Supabase SDK not loaded');
        const errMsg = document.getElementById('auth-error-msg');
        if (errMsg) {
            errMsg.textContent = 'System Error: Database not connected.';
            errMsg.style.display = 'block';
        }
    }
});

// Helper: Format Date
function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString('default', { month: 'short', year: 'numeric' });
}

// Back Button Functionality
function goBack() {
    window.location.href = 'index.html';
}

// Auth Handlers
const loginForm = document.getElementById('billing-login-form');
const registerForm = document.getElementById('billing-register-form');
const forgotUsernameForm = document.getElementById('billing-forgot-username-form');
const forgotBirthdateForm = document.getElementById('billing-forgot-birthdate-form');
const forgotSecurityForm = document.getElementById('billing-forgot-security-form');
const forgotResetForm = document.getElementById('billing-forgot-reset-form');

const recoveryState = {
    username: '',
    birthdate: '',
    question1: '',
    question2: '',
    answer1: '',
    answer2: ''
};

function resetForgotRecoveryState() {
    recoveryState.username = '';
    recoveryState.birthdate = '';
    recoveryState.question1 = '';
    recoveryState.question2 = '';
    recoveryState.answer1 = '';
    recoveryState.answer2 = '';

    if (forgotUsernameForm) forgotUsernameForm.reset();
    if (forgotBirthdateForm) forgotBirthdateForm.reset();
    if (forgotSecurityForm) forgotSecurityForm.reset();
    if (forgotResetForm) forgotResetForm.reset();

    const q1Label = document.getElementById('forgot-question-1-label');
    const q2Label = document.getElementById('forgot-question-2-label');
    if (q1Label) q1Label.textContent = 'Security Question 1';
    if (q2Label) q2Label.textContent = 'Security Question 2';
}

function parseRpcJson(data) {
    if (!data) return {};
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (_error) {
            return { error: data };
        }
    }
    return data;
}

function setFormError(targetId, message = '') {
    const errorNode = document.getElementById(targetId);
    if (!errorNode) return;
    if (!message) {
        errorNode.textContent = '';
        errorNode.style.display = 'none';
        return;
    }
    errorNode.textContent = message;
    errorNode.style.display = 'block';
}

function setAuthMode(mode = 'login') {
    const formMap = {
        login: loginForm,
        register: registerForm,
        forgot_username: forgotUsernameForm,
        forgot_birthdate: forgotBirthdateForm,
        forgot_security: forgotSecurityForm,
        forgot_reset: forgotResetForm
    };

    Object.values(formMap).forEach((formNode) => {
        if (formNode) formNode.style.display = 'none';
    });

    const activeForm = formMap[mode] || loginForm;
    if (activeForm) activeForm.style.display = 'flex';

    const isRegister = mode === 'register';
    const isForgot = mode.startsWith('forgot_');
    const authPanel = document.getElementById('billing-auth-container');
    const subtitle = document.getElementById('auth-subtitle');

    if (authPanel) authPanel.classList.toggle('account-mode-register', isRegister);
    if (authPanel) authPanel.classList.toggle('account-mode-forgot', isForgot);
    if (subtitle) {
        if (isRegister) {
            subtitle.textContent = 'Create Account';
        } else if (isForgot) {
            subtitle.textContent = 'Account Recovery';
        } else {
            subtitle.textContent = 'Electric Bill Tracker';
        }
    }

    if (isRegister && registerForm) registerForm.scrollTop = 0;
    if (isForgot && activeForm) activeForm.scrollTop = 0;

    setFormError('auth-error-msg', '');
    setFormError('auth-register-error-msg', '');
    setFormError('auth-forgot-error-msg', '');
}

window.showRegisterForm = function () {
    setAuthMode('register');
};

window.showLoginForm = function () {
    resetForgotRecoveryState();
    setAuthMode('login');
};

window.showForgotPasswordForm = function () {
    resetForgotRecoveryState();
    const loginUsername = (document.getElementById('auth-username')?.value || '').trim();
    const forgotUsername = document.getElementById('forgot-username');
    if (forgotUsername && loginUsername) forgotUsername.value = loginUsername;
    setAuthMode('forgot_username');
};

window.resetForgotPasswordFlow = function () {
    resetForgotRecoveryState();
    setAuthMode('forgot_username');
};

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = (document.getElementById('auth-username')?.value || '').trim();
        const password = document.getElementById('auth-password')?.value || '';

        setFormError('auth-error-msg', '');

        if (!username || !password) {
            setFormError('auth-error-msg', 'Username and password are required.');
            return;
        }

        const submitBtn = loginForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            // Call Custom Login RPC
            const { data, error } = await supabaseClient.rpc('custom_login', {
                p_username: username,
                p_password: password
            });

            if (error) throw error;

            const loginResult = parseRpcJson(data);
            if (loginResult.error) {
                throw new Error(loginResult.error);
            }

            if (loginResult.success) {
                // Save Session
                currentUser = loginResult.user;
                localStorage.setItem('billing_user', JSON.stringify(currentUser));
                showToast('Logged in successfully!', 'success');
                handleSession();
                return;
            }

            throw new Error('Login failed.');
        } catch (err) {
            // Show clean error message instead of debug info
            setFormError('auth-error-msg', 'Incorrect username or password.');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setFormError('auth-register-error-msg', '');

        const username = (document.getElementById('reg-username')?.value || '').trim();
        const firstName = (document.getElementById('reg-first-name')?.value || '').trim();
        const lastName = (document.getElementById('reg-last-name')?.value || '').trim();
        const contactInfo = (document.getElementById('reg-contact-info')?.value || '').trim();
        const password = document.getElementById('reg-password')?.value || '';
        const passwordConfirm = document.getElementById('reg-password-confirm')?.value || '';
        const question1 = (document.getElementById('reg-security-question-1')?.value || '').trim();
        const answer1 = (document.getElementById('reg-security-answer-1')?.value || '').trim();
        const question2 = (document.getElementById('reg-security-question-2')?.value || '').trim();
        const answer2 = (document.getElementById('reg-security-answer-2')?.value || '').trim();
        const birthdate = document.getElementById('reg-birthdate')?.value || null;
        const tenantLocation = (document.getElementById('reg-tenant-location')?.value || '').trim();

        const usernamePattern = /^[A-Za-z0-9_.-]{3,50}$/;
        if (!usernamePattern.test(username)) {
            setFormError('auth-register-error-msg', 'Username must be 3-50 chars (letters, numbers, _, ., -).');
            return;
        }

        if (password.length < 6) {
            setFormError('auth-register-error-msg', 'Password must be at least 6 characters.');
            return;
        }

        if (password !== passwordConfirm) {
            setFormError('auth-register-error-msg', 'Password confirmation does not match.');
            return;
        }

        if (!birthdate) {
            setFormError('auth-register-error-msg', 'Birthdate is required.');
            return;
        }

        if (!firstName || !lastName || !contactInfo || !question1 || !answer1 || !question2 || !answer2) {
            setFormError('auth-register-error-msg', 'Please complete all required fields.');
            return;
        }

        const normalizedQuestions = [question1, question2].map(value => value.toLowerCase());
        if (new Set(normalizedQuestions).size !== 2) {
            setFormError('auth-register-error-msg', 'Please choose 2 different security questions.');
            return;
        }

        const submitBtn = registerForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { data, error } = await supabaseClient.rpc('custom_register_user', {
                p_username: username,
                p_password: password,
                p_first_name: firstName,
                p_last_name: lastName,
                p_contact_info: contactInfo,
                p_birthdate: birthdate || null,
                p_tenant_location: tenantLocation || null,
                p_security_question_1: question1,
                p_security_answer_1: answer1,
                p_security_question_2: question2,
                p_security_answer_2: answer2
            });

            if (error) throw error;

            const registerResult = parseRpcJson(data);
            if (!registerResult.success) {
                throw new Error(registerResult.error || 'Unable to create account.');
            }

            registerForm.reset();
            showToast('Account created. You can now sign in.', 'success');
            setAuthMode('login');

            const usernameInput = document.getElementById('auth-username');
            if (usernameInput) usernameInput.value = username;
            const passwordInput = document.getElementById('auth-password');
            if (passwordInput) passwordInput.focus();
        } catch (err) {
            const message = err && err.message ? err.message : 'Unable to create account. Please try again.';
            setFormError('auth-register-error-msg', message);
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

if (forgotUsernameForm) {
    forgotUsernameForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setFormError('auth-forgot-error-msg', '');

        const username = (document.getElementById('forgot-username')?.value || '').trim();
        if (!username) {
            setFormError('auth-forgot-error-msg', 'Username is required.');
            return;
        }

        const submitBtn = forgotUsernameForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { data, error } = await supabaseClient.rpc('custom_recovery_lookup_user', {
                p_username: username
            });
            if (error) throw error;

            const lookupResult = parseRpcJson(data);
            if (!lookupResult.success) {
                throw new Error(lookupResult.error || 'Unable to continue recovery.');
            }

            recoveryState.username = lookupResult.username || username;
            const birthdateField = document.getElementById('forgot-birthdate');
            if (birthdateField) birthdateField.value = '';
            setAuthMode('forgot_birthdate');
        } catch (err) {
            setFormError('auth-forgot-error-msg', err?.message || 'Unable to continue recovery.');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

if (forgotBirthdateForm) {
    forgotBirthdateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setFormError('auth-forgot-error-msg', '');

        const birthdate = document.getElementById('forgot-birthdate')?.value || '';
        if (!birthdate) {
            setFormError('auth-forgot-error-msg', 'Birthdate is required.');
            return;
        }

        const submitBtn = forgotBirthdateForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { data, error } = await supabaseClient.rpc('custom_recovery_verify_birthdate', {
                p_username: recoveryState.username,
                p_birthdate: birthdate
            });
            if (error) throw error;

            const verifyResult = parseRpcJson(data);
            if (!verifyResult.success) {
                throw new Error(verifyResult.error || 'Birthdate verification failed.');
            }

            recoveryState.birthdate = birthdate;
            recoveryState.question1 = String(verifyResult.question_1 || 'Security Question 1');
            recoveryState.question2 = String(verifyResult.question_2 || 'Security Question 2');

            const q1Label = document.getElementById('forgot-question-1-label');
            const q2Label = document.getElementById('forgot-question-2-label');
            if (q1Label) q1Label.textContent = recoveryState.question1.toUpperCase();
            if (q2Label) q2Label.textContent = recoveryState.question2.toUpperCase();

            setAuthMode('forgot_security');
        } catch (err) {
            setFormError('auth-forgot-error-msg', err?.message || 'Birthdate verification failed.');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

if (forgotSecurityForm) {
    forgotSecurityForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setFormError('auth-forgot-error-msg', '');

        const answer1 = (document.getElementById('forgot-answer-1')?.value || '').trim();
        const answer2 = (document.getElementById('forgot-answer-2')?.value || '').trim();
        if (!answer1 || !answer2) {
            setFormError('auth-forgot-error-msg', 'Please answer both security questions.');
            return;
        }

        const submitBtn = forgotSecurityForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { data, error } = await supabaseClient.rpc('custom_recovery_verify_answers', {
                p_username: recoveryState.username,
                p_birthdate: recoveryState.birthdate || null,
                p_answer_1: answer1,
                p_answer_2: answer2
            });
            if (error) throw error;

            const verifyResult = parseRpcJson(data);
            if (!verifyResult.success) {
                throw new Error(verifyResult.error || 'Security answer verification failed.');
            }

            recoveryState.answer1 = answer1;
            recoveryState.answer2 = answer2;
            setAuthMode('forgot_reset');
        } catch (err) {
            setFormError('auth-forgot-error-msg', err?.message || 'Security answer verification failed.');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

if (forgotResetForm) {
    forgotResetForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setFormError('auth-forgot-error-msg', '');

        const newPassword = document.getElementById('forgot-new-password')?.value || '';
        const confirmPassword = document.getElementById('forgot-confirm-password')?.value || '';

        if (newPassword.length < 6) {
            setFormError('auth-forgot-error-msg', 'Password must be at least 6 characters.');
            return;
        }

        if (newPassword !== confirmPassword) {
            setFormError('auth-forgot-error-msg', 'Password confirmation does not match.');
            return;
        }

        const submitBtn = forgotResetForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;

        try {
            const { data, error } = await supabaseClient.rpc('custom_recovery_reset_password', {
                p_username: recoveryState.username,
                p_birthdate: recoveryState.birthdate || null,
                p_answer_1: recoveryState.answer1,
                p_answer_2: recoveryState.answer2,
                p_new_password: newPassword
            });
            if (error) throw error;

            const resetResult = parseRpcJson(data);
            if (!resetResult.success) {
                throw new Error(resetResult.error || 'Unable to reset password.');
            }

            showToast('Password reset successful. You can now sign in.', 'success');
            const usernameInput = document.getElementById('auth-username');
            if (usernameInput) usernameInput.value = recoveryState.username;
            resetForgotRecoveryState();
            setAuthMode('login');
        } catch (err) {
            setFormError('auth-forgot-error-msg', err?.message || 'Unable to reset password.');
        } finally {
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}

function logoutBilling() {
    localStorage.removeItem('billing_user');
    currentUser = null;
    showSection('public');
    fetchPublicBills();
}

function checkSession() {
    const storedUser = localStorage.getItem('billing_user');
    if (storedUser) {
        currentUser = JSON.parse(storedUser);
        handleSession();
    } else {
        showSection('public');
        fetchPublicBills();
        startBillingAutoSync();
    }
}

function updateTenantRoomLabel(roomText = '') {
    const roomEl = document.getElementById('tenant-room-no');
    if (!roomEl) return;
    roomEl.textContent = roomText || 'Not Assigned';
}

async function refreshCurrentUserProfile(force = false) {
    if (!supabaseClient || !currentUser || currentUser.role === 'admin' || !userProfileRefreshAllowed) return;

    const now = Date.now();
    if (!force && now - lastUserProfileRefreshAt < USER_PROFILE_REFRESH_MS) return;
    lastUserProfileRefreshAt = now;

    try {
        const { data, error } = await supabaseClient
            .from('users')
            .select('role, tenant_location')
            .eq('id', currentUser.id)
            .maybeSingle();

        if (error) {
            const message = String(error.message || '');
            if (/permission|denied|not authorized|policy/i.test(message)) {
                userProfileRefreshAllowed = false;
            }
            return;
        }
        if (!data) return;

        const nextRole = data.role || currentUser.role || 'user';
        const nextLocation = data.tenant_location || '';
        const roleChanged = String(nextRole) !== String(currentUser.role);
        const locationChanged = String(nextLocation) !== String(currentUser.tenant_location || '');
        if (!roleChanged && !locationChanged) return;

        currentUser = {
            ...currentUser,
            role: nextRole,
            tenant_location: nextLocation
        };
        localStorage.setItem('billing_user', JSON.stringify(currentUser));
        if (currentUser.role === 'admin') {
            handleSession();
            return;
        }
        updateTenantRoomLabel(currentUser.tenant_location || 'Not Assigned');
    } catch (_err) {
        // Silent fallback: live UI still refreshes from bills.
    }
}

function getActiveBillingSection() {
    const isVisible = (id) => {
        const node = document.getElementById(id);
        return !!(node && node.style.display !== 'none');
    };

    if (isVisible('billing-admin-view')) return 'admin';
    if (isVisible('billing-tenant-view')) return 'tenant';
    if (isVisible('billing-public-view')) return 'public';
    return 'unknown';
}

async function refreshBillingLiveData(force = false) {
    if (!supabaseClient) return;
    if (document.hidden) return;
    if (shouldSkipAutoRefreshWhileInteracting(force)) return;
    if (billingRefreshBusy) return;

    const renderOptions = {
        silent: !force,
        preserveScroll: true,
        forceRender: force
    };

    billingRefreshBusy = true;
    try {
        const section = getActiveBillingSection();

        if (section === 'admin') {
            await fetchAdminBills(renderOptions);
            return;
        }

        if (section === 'tenant') {
            await refreshCurrentUserProfile(force);
            await fetchTenantBills(renderOptions);
            await fetchPublicBills({ silent: true, preserveScroll: false, forceRender: false });
            await populatePaymentRoomDropdown({ sourceData: window.publicBillsData });
            return;
        }

        if (section === 'public') {
            await fetchPublicBills(renderOptions);
            await populatePaymentRoomDropdown({ sourceData: window.publicBillsData });
        }
    } finally {
        billingRefreshBusy = false;
    }
}

function startBillingAutoSync() {
    if (billingAutoRefreshTimer) {
        clearInterval(billingAutoRefreshTimer);
    }

    billingAutoRefreshTimer = setInterval(() => {
        refreshBillingLiveData(false);
    }, BILLING_AUTO_REFRESH_MS);

    if (supabaseClient && !billingRealtimeChannel && typeof supabaseClient.channel === 'function') {
        billingRealtimeChannel = supabaseClient
            .channel('billing-live-sync')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'bills' }, () => {
                queueRealtimeBillingRefresh(false);
            })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'tenant_locations' }, () => {
                queueRealtimeBillingRefresh(false);
            })
            .subscribe();
    }
}

function handleSession() {
    if (!currentUser) {
        showSection('public');
        fetchPublicBills();
        return;
    }

    if (currentUser.role === 'admin') {
        showSection('admin');
        fetchAdminBills();
    } else {
        showSection('tenant');
        updateTenantRoomLabel(currentUser.tenant_location || 'Not Assigned');
        fetchTenantBills();
    }

    startBillingAutoSync();
}

function showSection(section) {
    const publicView = document.getElementById('billing-public-view');
    const authContainer = document.getElementById('billing-auth-container');
    const tenantView = document.getElementById('billing-tenant-view');
    const adminView = document.getElementById('billing-admin-view');
    const sharedPayment = document.getElementById('shared-payment-container');

    if (publicView) publicView.style.display = section === 'public' ? 'block' : 'none';
    if (authContainer) authContainer.style.display = section === 'login' ? 'block' : 'none';
    if (tenantView) tenantView.style.display = section === 'tenant' ? 'block' : 'none';
    if (adminView) adminView.style.display = section === 'admin' ? 'block' : 'none';

    // Show payment container on Public or Tenant view
    if (sharedPayment) {
        if (section === 'public' || section === 'tenant') {
            sharedPayment.style.display = 'block';
        } else {
            sharedPayment.style.display = 'none';
        }
    }
}

// Show login modal (from public view)
window.showLoginModal = function () {
    showSection('login');
    setAuthMode('login');
};

// Close login modal (return to public view)
window.closeLoginModal = function () {
    resetForgotRecoveryState();
    setAuthMode('login');
    showSection('public');
    fetchPublicBills();
};

// Toggle password visibility
window.togglePasswordField = function (inputId, iconId) {
    const passwordInput = document.getElementById(inputId);
    const eyeIcon = document.getElementById(iconId);
    if (!passwordInput || !eyeIcon) return;

    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        // Eye-off icon
        eyeIcon.innerHTML = `
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
            <line x1="1" y1="1" x2="23" y2="23"></line>
        `;
        return;
    }

    passwordInput.type = 'password';
    // Eye icon
    eyeIcon.innerHTML = `
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
    `;
};

window.togglePassword = function () {
    window.togglePasswordField('auth-password', 'eye-icon');
};

// Public View Logic (No authentication required)
async function fetchPublicBills(options = {}) {
    const {
        silent = false,
        preserveScroll = false,
        forceRender = false
    } = options;

    const tbody = document.getElementById('public-billing-body');
    if (!tbody) return;
    const scrollSnapshot = captureTableScroll(tbody, preserveScroll);

    if (!silent) {
        tbody.innerHTML = '<tr><td colspan=\'6\'>Loading...</td></tr>';
    }

    let data = null;
    let error = null;

    // Try using the get_public_bills RPC first (if exists)
    const result1 = await supabaseClient.rpc('get_public_bills');
    if (!result1.error && result1.data) {
        data = result1.data;
    } else {
        // Fallback: Try direct query to bills table (if RLS allows)
        const result2 = await supabaseClient
            .from('bills')
            .select('id, room_no, month, period_start, period_end, previous_reading, current_reading, rate, amount, status');

        if (!result2.error && result2.data) {
            data = result2.data;
        } else {
            error = result2.error || result1.error;
        }
    }

    if (error) {
        window.publicBillsData = [];
        BILLING_RENDER_SIGNATURES.public = '';
        if (!silent || !tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan=\'6\'>Unable to load billing data. Please login to view.</td></tr>';
        }
        console.error('Public fetch error:', error);
        return [];
    }

    if (!data || data.length === 0) {
        window.publicBillsData = [];
        BILLING_RENDER_SIGNATURES.public = '[]';
        tbody.innerHTML = '<tr><td colspan=\'6\'>No records found.</td></tr>';
        restoreTableScroll(scrollSnapshot);
        return [];
    }

    // Sort records by room_no in natural alphanumeric order
    data.sort((a, b) => {
        return a.room_no.localeCompare(b.room_no, undefined, { numeric: true, sensitivity: 'base' });
    });
    window.publicBillsData = data;

    const nextSignature = makeBillsSignature(data, [
        'id',
        'room_no',
        'month',
        'period_start',
        'period_end',
        'previous_reading',
        'current_reading',
        'rate',
        'amount',
        'status'
    ]);
    if (!forceRender && nextSignature === BILLING_RENDER_SIGNATURES.public && tbody.children.length) {
        return data;
    }
    BILLING_RENDER_SIGNATURES.public = nextSignature;

    tbody.innerHTML = data.map(record => {
        const kwhUsed = (record.current_reading - record.previous_reading).toFixed(1);
        const amount = (kwhUsed * record.rate).toFixed(2);
        return `
        <tr>
            <td style='font-weight:bold;'>${record.room_no}</td>
            <td>${formatPeriod(record.period_start, record.period_end, record.month)}</td>
            <td>${kwhUsed} kWh</td>
            <td style='font-weight:bold; color: ${record.status === 'PAID' ? '#9ACD32' : '#FFA500'};'>${CURRENCY_SYMBOL}${amount}</td>
            <td><span class='status-badge ${record.status === 'PAID' ? 'status-paid' : 'status-due'}'>${record.status}</span></td>
            <td>
                <small>Prev: ${record.previous_reading} | Curr: ${record.current_reading} | Rate: ${CURRENCY_SYMBOL}${record.rate}</small>
            </td>
        </tr>
    `}).join('');
    restoreTableScroll(scrollSnapshot);
    return data;
}

// Global data store for edit modal
window.allBillingRecords = [];

// Tenant Logic
async function fetchTenantBills(options = {}) {
    const {
        silent = false,
        preserveScroll = false,
        forceRender = false
    } = options;

    const tbody = document.getElementById('tenant-billing-body');
    if (!tbody) return;
    const scrollSnapshot = captureTableScroll(tbody, preserveScroll);

    if (!silent) {
        tbody.innerHTML = '<tr><td colspan=\'6\'>Loading...</td></tr>';
    }

    // Use RPC to get bills safe for this user
    const { data, error } = await supabaseClient.rpc('get_bills', { p_user_id: currentUser.id });

    if (error) {
        BILLING_RENDER_SIGNATURES.tenant = '';
        if (!silent || !tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan=\'6\'>Error: ' + error.message + '</td></tr>';
        }
        return;
    }

    if (!data || data.length === 0) {
        BILLING_RENDER_SIGNATURES.tenant = '[]';
        tbody.innerHTML = '<tr><td colspan=\'6\'>No records found.</td></tr>';
        restoreTableScroll(scrollSnapshot);
        return;
    }

    // Sort records by room_no in natural alphanumeric order
    data.sort((a, b) => {
        return a.room_no.localeCompare(b.room_no, undefined, { numeric: true, sensitivity: 'base' });
    });

    // Get user's room (normalize for comparison - remove all spaces)
    const normalizeRoom = (room) => (room || '').toLowerCase().replace(/\s+/g, '');
    const userRoom = normalizeRoom(currentUser.tenant_location);
    const matchedRoomRecord = data.find((record) => normalizeRoom(record.room_no) === userRoom);
    if (matchedRoomRecord) {
        updateTenantRoomLabel(matchedRoomRecord.room_no);
    }

    const nextSignature = makeBillsSignature(data, [
        'id',
        'room_no',
        'month',
        'period_start',
        'period_end',
        'previous_reading',
        'current_reading',
        'kwh_used',
        'rate',
        'amount',
        'status'
    ]);
    if (!forceRender && nextSignature === BILLING_RENDER_SIGNATURES.tenant && tbody.children.length) {
        return;
    }
    BILLING_RENDER_SIGNATURES.tenant = nextSignature;

    tbody.innerHTML = data.map(record => {
        const isMyRoom = normalizeRoom(record.room_no) === userRoom;
        return `
        <tr class="${isMyRoom ? 'my-room-row' : ''}">
            <td style='font-weight:bold;'>${record.room_no}${isMyRoom ? ' <span style="color:#FFA500;font-size:0.65rem;">(You)</span>' : ''}</td>
            <td>${formatPeriod(record.period_start, record.period_end, record.month)}</td>
            <td>${record.kwh_used} kWh</td>
            <td style='font-weight:bold; color: ${record.status === 'PAID' ? '#9ACD32' : '#FFA500'};'>${CURRENCY_SYMBOL}${record.amount.toFixed(2)}</td>
            <td><span class='status-badge ${record.status === 'PAID' ? 'status-paid' : 'status-due'}'>${record.status}</span></td>
            <td>
                <small>Prev: ${record.previous_reading} | Curr: ${record.current_reading} | Rate: ${CURRENCY_SYMBOL}${record.rate}</small>
            </td>
        </tr>
    `}).join('');
    restoreTableScroll(scrollSnapshot);
}

// Admin Logic
async function fetchAdminBills(options = {}) {
    const {
        silent = false,
        preserveScroll = false,
        forceRender = false
    } = options;

    const tbody = document.getElementById('admin-billing-body');
    if (!tbody) return;
    const scrollSnapshot = captureTableScroll(tbody, preserveScroll);

    if (!silent) {
        tbody.innerHTML = '<tr><td colspan=\'9\'>Loading...</td></tr>';
    }

    const { data, error } = await supabaseClient.rpc('get_bills', { p_user_id: currentUser.id });

    if (error) {
        BILLING_RENDER_SIGNATURES.admin = '';
        if (!silent || !tbody.children.length) {
            tbody.innerHTML = '<tr><td colspan=\'9\'>Error: ' + error.message + '</td></tr>';
        }
        return;
    }

    window.allBillingRecords = data || []; // Store for edit/print

    if (!data || data.length === 0) {
        BILLING_RENDER_SIGNATURES.admin = '[]';
        tbody.innerHTML = '<tr><td colspan=\'9\'>No records found.</td></tr>';
        restoreTableScroll(scrollSnapshot);
        return;
    }

    // Sort records by room_no in natural alphanumeric order
    data.sort((a, b) => {
        return a.room_no.localeCompare(b.room_no, undefined, { numeric: true, sensitivity: 'base' });
    });

    const nextSignature = makeBillsSignature(data, [
        'id',
        'room_no',
        'month',
        'period_start',
        'period_end',
        'previous_reading',
        'current_reading',
        'kwh_used',
        'rate',
        'amount',
        'status'
    ]);
    if (!forceRender && nextSignature === BILLING_RENDER_SIGNATURES.admin && tbody.children.length) {
        return;
    }
    BILLING_RENDER_SIGNATURES.admin = nextSignature;

    tbody.innerHTML = data.map(record => `
        <tr>
            <td style='font-weight:bold;'>${record.room_no}</td>
            <td>${formatPeriod(record.period_start, record.period_end, record.month)}</td>
            <td>${record.previous_reading}/${record.current_reading}</td>
            <td>${record.kwh_used}</td>
            <td>${CURRENCY_SYMBOL}${record.rate}</td>
            <td style='font-weight:bold; color: ${record.status === 'PAID' ? '#9ACD32' : '#FFA500'};'>${CURRENCY_SYMBOL}${record.amount.toFixed(2)}</td>
            <td><span class='status-badge ${record.status === 'PAID' ? 'status-paid' : 'status-due'}'>${record.status}</span></td>
            <td style="display:flex; gap:4px;">
                <button onclick='editRecord("${record.id}")' class='icon-btn edit-icon' title="Edit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button onclick='deleteRecord("${record.id}")' class='icon-btn del-icon' title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </td>
        </tr>
    `).join('');
    restoreTableScroll(scrollSnapshot);
}

// Helper to format period display (compact for mobile)
function formatPeriod(start, end, month) {
    const shortDate = (d) => {
        if (!d) return '';
        const date = new Date(d);
        const yr = String(date.getFullYear()).slice(-2);
        return `${date.getMonth() + 1}/${date.getDate()}/${yr}`;
    };

    if (start && end) {
        return `${shortDate(start)}-${shortDate(end)}`;
    }
    if (month) {
        const d = new Date(month);
        return `${d.getMonth() + 1}/${d.getFullYear()}`;
    }
    return '-';
}

// CRUD
// Template defaults for new records
const BILLING_TEMPLATE = {
    periodStart: '2026-01-01',
    periodEnd: '2026-01-31',
    rate: 16.9
};

window.openAddRecordModal = function () {
    const form = document.getElementById('admin-record-form');
    if (form) form.reset();

    // Reset apply checkboxes
    if (document.getElementById('apply-all-period')) document.getElementById('apply-all-period').checked = false;
    if (document.getElementById('apply-all-rate')) document.getElementById('apply-all-rate').checked = false;

    const idField = document.getElementById('record-id');
    if (idField) idField.value = '';

    const modalTitle = document.getElementById('modal-title');
    if (modalTitle) modalTitle.textContent = 'Add New Record';

    // Pre-fill template values for new records
    const periodStartField = document.getElementById('record-period-start');
    const periodEndField = document.getElementById('record-period-end');
    const monthField = document.getElementById('record-month');
    const rateField = document.getElementById('record-rate');

    if (periodStartField) periodStartField.value = BILLING_TEMPLATE.periodStart;
    if (periodEndField) periodEndField.value = BILLING_TEMPLATE.periodEnd;
    if (monthField) monthField.value = BILLING_TEMPLATE.periodEnd;
    if (rateField) rateField.value = BILLING_TEMPLATE.rate;

    // Load room suggestions
    loadRoomSuggestions();

    const modal = document.getElementById('admin-modal');
    if (modal) modal.style.display = 'flex';
}

// Fetch rooms from tenant_locations for dropdown suggestions
let allRooms = [];
let availableRooms = []; // Rooms not yet in billing records

async function loadRoomSuggestions() {
    if (!supabaseClient) return;

    const { data, error } = await supabaseClient
        .from('tenant_locations')
        .select('name')
        .order('name');

    if (error) {
        console.error('Error loading rooms:', error);
        return;
    }

    allRooms = data || [];

    // Filter out rooms that already have billing records
    const existingRooms = (window.allBillingRecords || []).map(r => r.room_no.toLowerCase());
    availableRooms = allRooms.filter(room => !existingRooms.includes(room.name.toLowerCase()));
}

function renderRoomDropdown(rooms) {
    const dropdown = document.getElementById('room-dropdown');
    if (!dropdown) return;

    if (rooms.length === 0) {
        dropdown.innerHTML = '<div class="room-option" style="color: #888; cursor: default;">All rooms already have records</div>';
    } else {
        dropdown.innerHTML = rooms.map(r =>
            `<div class="room-option" onclick="selectRoom('${r.name}')">${r.name}</div>`
        ).join('');
    }
}

window.showRoomDropdown = async function () {
    await loadRoomSuggestions(); // Always refresh to get latest available rooms
    const dropdown = document.getElementById('room-dropdown');
    if (dropdown) {
        renderRoomDropdown(availableRooms);
        dropdown.style.display = 'block';
    }
};

window.filterRoomDropdown = function () {
    const input = document.getElementById('record-room').value.toLowerCase();
    const filtered = availableRooms.filter(r => r.name.toLowerCase().includes(input));
    renderRoomDropdown(filtered);
    const dropdown = document.getElementById('room-dropdown');
    if (dropdown) dropdown.style.display = 'block';
};

window.selectRoom = function (name) {
    document.getElementById('record-room').value = name;
    document.getElementById('room-dropdown').style.display = 'none';
};

// Hide dropdown when clicking outside
document.addEventListener('click', function (e) {
    const wrapper = document.querySelector('.room-dropdown-wrapper');
    const dropdown = document.getElementById('room-dropdown');
    if (wrapper && dropdown && !wrapper.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});

window.closeAdminModal = function () {
    const modal = document.getElementById('admin-modal');
    if (modal) modal.style.display = 'none';
}

window.editRecord = function (id) {
    const record = window.allBillingRecords.find(r => r.id === id);
    if (!record) return;

    document.getElementById('record-id').value = record.id;
    document.getElementById('record-room').value = record.room_no;

    // Set dates
    if (record.period_start) document.getElementById('record-period-start').value = record.period_start;
    if (record.period_end) {
        document.getElementById('record-period-end').value = record.period_end;
        document.getElementById('record-month').value = record.period_end;
    } else {
        document.getElementById('record-month').value = record.month;
    }

    document.getElementById('record-prev').value = record.previous_reading;
    document.getElementById('record-curr').value = record.current_reading;
    document.getElementById('record-rate').value = record.rate;
    document.getElementById('record-status').value = record.status;

    document.getElementById('modal-title').textContent = 'Edit Record';
    document.getElementById('admin-modal').style.display = 'flex';
}

const recordForm = document.getElementById('admin-record-form');
if (recordForm) {
    recordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('record-id').value;
        const room_no = document.getElementById('record-room').value.trim();

        // Check for duplicate room when adding new record (not editing)
        if (!id) {
            // Refresh data from server to ensure we have latest records
            const { data: latestRecords } = await supabaseClient.rpc('get_bills', { p_user_id: currentUser.id });
            const existingRoom = (latestRecords || []).find(
                r => r.room_no.toLowerCase().trim() === room_no.toLowerCase()
            );
            if (existingRoom) {
                showToast(`Record for "${room_no}" already exists. Please edit the existing record instead.`, 'error');
                return;
            }
        }

        // Dates
        const p_start = document.getElementById('record-period-start').value;
        const p_end = document.getElementById('record-period-end').value;
        // Use end date as the "month" for sorting if not explicit, or just strictly use end date
        const billing_month = p_end;

        const previous_reading = document.getElementById('record-prev').value;
        const current_reading = document.getElementById('record-curr').value;
        const rate = document.getElementById('record-rate').value;
        const status = document.getElementById('record-status').value;

        const payload = {
            p_user_id: currentUser.id,
            p_id: id || null,
            p_room_no: room_no,
            p_month: billing_month,
            p_period_start: p_start,
            p_period_end: p_end,
            p_previous_reading: parseFloat(previous_reading),
            p_current_reading: parseFloat(current_reading),
            p_rate: parseFloat(rate),
            p_status: status
        };

        const { data, error } = await supabaseClient.rpc('upsert_bill', payload);

        if (error) {
            showToast('Error saving record: ' + error.message, 'error');
        } else {
            // --- BULK UPDATES ---
            const applyPeriod = document.getElementById('apply-all-period').checked;
            const applyRate = document.getElementById('apply-all-rate').checked;

            if (applyPeriod) {
                // Use direct update to ensure it works even if RPC is missing
                const { error: periodError } = await supabaseClient
                    .from('bills')
                    .update({
                        period_start: p_start,
                        period_end: p_end,
                        month: p_end // Legacy sync
                    })
                    .eq('user_id', currentUser.id);

                if (periodError) {
                    showToast("Bulk Update Failed: " + periodError.message, 'error');
                    console.error("Bulk Period Error:", periodError);
                } else {
                    showToast("Success! Billing period updated for ALL records.");
                }
            }


            if (applyRate) {
                const { error: rateError } = await supabaseClient.rpc('bulk_update_rate', {
                    p_user_id: currentUser.id,
                    p_rate: parseFloat(rate)
                });
                if (rateError) {
                    showToast("Bulk Update Failed: " + rateError.message, 'error');
                    console.error("Bulk Rate Error:", rateError);
                } else {
                    showToast("Success! Rate updated for ALL records.");
                }
            }

            closeAdminModal();
            fetchAdminBills();
        }
    });
}

// --- Custom Notifications (Toasts) ---
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const normalizedType = ['success', 'error', 'info', 'warning'].includes(type) ? type : 'info';
    const icons = {
        success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>',
        error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
        info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
        warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
    };
    const titles = {
        success: 'Success',
        error: 'Error',
        info: 'Notice',
        warning: 'Warning'
    };

    const toast = document.createElement('article');
    toast.className = `toast toast-${normalizedType}`;
    toast.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', normalizedType === 'error' ? 'assertive' : 'polite');

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.innerHTML = icons[normalizedType] || icons.info;

    const body = document.createElement('div');
    body.className = 'toast-body';

    const title = document.createElement('span');
    title.className = 'toast-title';
    title.textContent = titles[normalizedType] || titles.info;

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.innerHTML = '<span aria-hidden="true">&times;</span>';

    const progress = document.createElement('div');
    progress.className = 'toast-progress';

    body.append(title, text);
    toast.append(icon, body, closeBtn, progress);
    container.prepend(toast);

    requestAnimationFrame(() => toast.classList.add('is-visible'));

    while (container.children.length > 4) {
        container.lastElementChild.remove();
    }

    const dismissToast = () => {
        if (!toast.isConnected || toast.classList.contains('is-leaving')) return;
        toast.classList.add('is-leaving');
        setTimeout(() => {
            if (toast.isConnected) toast.remove();
        }, 220);
    };

    closeBtn.addEventListener('click', dismissToast);
    setTimeout(dismissToast, 4600);
}

// Backward compatibility alias for old button wiring
window.showComingSoonToast = function () {
    window.showRegisterForm();
};

// --- Custom Confirmation Modal ---
function showConfirm(message, onConfirm) {
    const modalId = 'custom-confirm-modal';
    const existing = document.getElementById(modalId);
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = modalId;
    overlay.className = 'notify-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'notify-dialog-title');

    overlay.innerHTML = `
        <div class="notify-dialog notify-dialog-danger">
            <div class="notify-dialog-header">
                <div class="notify-dialog-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                </div>
                <div>
                    <h4 id="notify-dialog-title">Delete record?</h4>
                    <p class="notify-dialog-subtitle">This action cannot be undone.</p>
                </div>
            </div>
            <div class="notify-dialog-body"></div>
            <div class="notify-dialog-footer">
                <button type="button" id="confirm-cancel" class="confirm-btn cancel">Cancel</button>
                <button type="button" id="confirm-ok" class="confirm-btn danger">Delete</button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    const body = overlay.querySelector('.notify-dialog-body');
    if (body) body.textContent = message;

    const closeDialog = () => {
        overlay.classList.remove('is-visible');
        setTimeout(() => {
            if (overlay.isConnected) overlay.remove();
        }, 180);
        document.removeEventListener('keydown', onKeyDown);
    };

    const onKeyDown = (event) => {
        if (event.key === 'Escape') closeDialog();
    };

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeDialog();
    });

    document.getElementById('confirm-cancel').onclick = closeDialog;
    document.getElementById('confirm-ok').onclick = () => {
        closeDialog();
        onConfirm();
    };

    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => overlay.classList.add('is-visible'));
    document.getElementById('confirm-cancel').focus();
}

window.deleteRecord = function (id) {
    showConfirm('Are you sure you want to delete this record?', async () => {
        const { data, error } = await supabaseClient.rpc('delete_bill', {
            p_user_id: currentUser.id,
            p_bill_id: id
        });

        if (error) {
            showToast('Error deleting record: ' + error.message, 'error');
        } else {
            showToast('Record deleted successfully!', 'success');
            fetchAdminBills();
        }
    });
}

// Print Report
window.printBillingReport = function () {
    const data = window.allBillingRecords || [];
    if (data.length === 0) {
        showToast('No records to print.', 'error');
        return;
    }

    let printContent = `
        <div class="header">
            <h1>LYNMARK BOARDING HOUSE ELECTRIC BILL</h1>
        </div>
        <table>
            <thead>
                <tr>
                    <th>Room</th>
                    <th>Billing Period</th>
                    <th>Readings (Prev - Curr)</th>
                    <th>Usage (kWh)</th>
                    <th>Rate</th>
                    <th>Amount</th>
                    <th style="text-align: center;">Status</th>
                    <th style="width: 150px;">Remarks</th>
                </tr>
            </thead>
            <tbody>
    `;

    data.forEach(record => {
        const usage = (record.current_reading - record.previous_reading).toFixed(1);
        printContent += `
            <tr>
                <td style="font-weight: bold;">${record.room_no}</td>
                <td>${formatPeriod(record.period_start, record.period_end, record.month)}</td>
                <td>${record.previous_reading} - ${record.current_reading}</td>
                <td>${record.kwh_used} kWh</td>
                <td>${CURRENCY_SYMBOL}${record.rate}</td>
                <td style="font-weight: bold;">${CURRENCY_SYMBOL}${record.amount.toFixed(2)}</td>
                <td style="text-align: center;"><span class="badge ${record.status === 'PAID' ? 'paid' : 'due'}">${record.status}</span></td>
                <td></td>
            </tr>
        `;
    });

    printContent += `
            </tbody>
        </table>
        <div class="footer">
            <p><strong>Total Records:</strong> ${data.length}</p>
            <p>Generated On: ${new Date().toLocaleString()}</p>
        </div>
    `;

    const printWindow = window.open('', '', 'width=900,height=600');
    printWindow.document.write(`
        <html>
        <head>
            <title>Electric Bill Report</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
                
                body {
                    font-family: 'Inter', sans-serif;
                    margin: 0;
                    padding: 20px;
                    color: #333;
                    background: #fff;
                }
                
                .header {
                    background: #FF8C00;
                    color: #000;
                    padding: 10px 30px;
                    margin-bottom: 0;
                    text-align: center;
                    -webkit-print-color-adjust: exact;
                    border: 1px solid #000;
                }

                table {
                    margin-top: 0;
                }
                
                .header h1 {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 700;
                    letter-spacing: 1px;
                    text-transform: uppercase;
                    color: #000;
                }

                .meta {
                    display: flex;
                    justify-content: space-between;
                    margin-bottom: 20px;
                    font-size: 14px;
                    color: #555;
                    border-bottom: 2px solid #eee;
                    padding-bottom: 10px;
                }

                table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 20px;
                    font-size: 15px;
                }
                
                thead tr {
                    background-color: #9ACD32;
                    color: #000;
                    text-align: left;
                    -webkit-print-color-adjust: exact;
                }
                
                th, td {
                    padding: 12px 15px;
                    border: 1px solid #333;
                    font-weight: 800; /* Extra Bold */
                }
                
                /* Zebra Striping */
                tbody tr:nth-child(even) {
                    background-color: #d3d3d3 !important; /* Visible Grey */
                    -webkit-print-color-adjust: exact;
                    print-color-adjust: exact;
                }

                .badge {
                    padding: 4px 8px;
                    border-radius: 6px;
                    font-weight: bold;
                    font-size: 11px;
                    color: white;
                    -webkit-print-color-adjust: exact;
                }
                
                .badge.paid {
                    background-color: #28a745;
                    border: 1px solid #1e7e34;
                }
                
                .badge.due {
                    background-color: #dc3545;
                    border: 1px solid #bd2130;
                }

                .footer {
                    margin-top: 30px;
                    text-align: center;
                    font-size: 12px;
                    color: #333;
                    border-top: 2px solid #FF8C00;
                    padding-top: 15px;
                }
                
                .footer p {
                    margin: 5px 0;
                }
            </style>
        </head>
        <body>
            ${printContent}
        </body>
        </html >
        `);

    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
        printWindow.print();
        printWindow.close();
    }, 500);
}

/* ================================================== */
/* PAYMENT SYSTEM FUNCTIONS                           */
/* ================================================== */

// Global storage for public bills data (for room selection dropdown)
window.publicBillsData = [];

// Load payment settings on page load
async function loadPaymentSettings() {
    if (!supabaseClient) return;

    try {
        const { data, error } = await supabaseClient.rpc('get_payment_settings');

        if (error) {
            console.error('Error loading payment settings:', error);
            return;
        }

        if (data && data.length > 0) {
            const settings = data[0];

            // Populate admin form fields
            const gcashNumberInput = document.getElementById('gcash-number');
            const gcashAccountInput = document.getElementById('gcash-account-name');
            const instructionsInput = document.getElementById('payment-instructions');
            const qrPreview = document.getElementById('qr-preview');

            if (gcashNumberInput) gcashNumberInput.value = settings.gcash_number || '';
            if (gcashAccountInput) gcashAccountInput.value = settings.gcash_account_name || '';
            if (instructionsInput) instructionsInput.value = settings.payment_instructions || '';
            if (qrPreview && settings.gcash_qr_url) {
                qrPreview.src = settings.gcash_qr_url;
                qrPreview.style.display = 'block';
                const placeholder = document.getElementById('qr-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            }

            // Populate public display fields
            const displayName = document.getElementById('display-gcash-name');
            const displayNumber = document.getElementById('display-gcash-number');
            const displayQR = document.getElementById('display-qr-code');
            const qrContainer = document.getElementById('qr-display-container');
            const displayInstructions = document.getElementById('display-instructions');

            if (displayName) displayName.textContent = settings.gcash_account_name || 'Not configured';
            if (displayNumber) displayNumber.textContent = settings.gcash_number || 'Not configured';
            if (displayInstructions) displayInstructions.textContent = settings.payment_instructions || 'No instructions available.';

            if (displayQR && settings.gcash_qr_url) {
                displayQR.src = settings.gcash_qr_url;
                if (qrContainer) qrContainer.style.display = 'inline-block';
                // Show the QR banner when QR code is displayed
                const qrBanner = document.getElementById('qr-banner-section');
                if (qrBanner) qrBanner.style.display = 'flex';
            }
        }
    } catch (err) {
        console.error('Failed to load payment settings:', err);
    }
}

// Preview QR Code before upload (Admin)
window.previewQRCode = function (input) {
    const file = input.files[0];
    if (!file) return;

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
        showToast('File too large. Maximum size is 2MB.', 'error');
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
        const preview = document.getElementById('qr-preview');
        const placeholder = document.getElementById('qr-placeholder');
        if (preview) {
            preview.src = e.target.result;
            preview.style.display = 'block';
            if (placeholder) placeholder.style.display = 'none';
        }
    };
    reader.readAsDataURL(file);
};

// Fullscreen QR Modal Functions
window.openQRFullscreen = function () {
    const qrImg = document.getElementById('display-qr-code');
    const modal = document.getElementById('qr-fullscreen-modal');
    const fullscreenImg = document.getElementById('qr-fullscreen-img');

    if (qrImg && modal && fullscreenImg) {
        fullscreenImg.src = qrImg.src;
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
};

window.closeQRFullscreen = function () {
    const modal = document.getElementById('qr-fullscreen-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
};

// Save payment settings (Admin)
window.savePaymentSettings = async function () {
    if (!currentUser || currentUser.role !== 'admin') {
        showToast('You must be an admin to save settings.', 'error');
        return;
    }

    const gcashNumber = document.getElementById('gcash-number').value.trim();
    const accountName = document.getElementById('gcash-account-name').value.trim();
    const instructions = document.getElementById('payment-instructions').value.trim();

    if (!gcashNumber || !accountName) {
        showToast('GCash number and account name are required.', 'error');
        return;
    }

    let qrUrl = null;

    // Check if a new QR file was uploaded
    const qrFile = document.getElementById('qr-upload').files[0];
    if (qrFile) {
        try {
            // Upload to Supabase Storage
            const fileName = `qr_${Date.now()}_${qrFile.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
            const { data: uploadData, error: uploadError } = await supabaseClient.storage
                .from('payment-assets')
                .upload(`qr-codes/${fileName}`, qrFile, {
                    cacheControl: '3600',
                    upsert: true
                });

            if (uploadError) {
                console.error('Upload error:', uploadError);
                showToast('Error uploading QR code. Please try again.', 'error');
                return;
            }

            // Get public URL
            const { data: urlData } = supabaseClient.storage
                .from('payment-assets')
                .getPublicUrl(`qr-codes/${fileName}`);

            qrUrl = urlData.publicUrl;
        } catch (err) {
            console.error('Upload failed:', err);
            showToast('Failed to upload QR code.', 'error');
            return;
        }
    } else {
        // Keep existing QR URL
        const preview = document.getElementById('qr-preview');
        if (preview && preview.src && !preview.src.includes('data:')) {
            qrUrl = preview.src;
        }
    }

    // Save to database
    const { error } = await supabaseClient.rpc('upsert_payment_settings', {
        p_gcash_number: gcashNumber,
        p_gcash_account_name: accountName,
        p_gcash_qr_url: qrUrl,
        p_payment_instructions: instructions
    });

    if (error) {
        console.error('Save error:', error);
        showToast('Error saving settings: ' + error.message, 'error');
    } else {
        showToast('Payment settings saved successfully!', 'success');
        loadPaymentSettings(); // Refresh display
    }
};

// Copy GCash number to clipboard
window.copyGcashNumber = function () {
    const numberEl = document.getElementById('display-gcash-number');
    if (!numberEl) return;

    const number = numberEl.textContent;
    if (number === 'Loading...' || number === 'Not configured') {
        showToast('No GCash number available to copy.', 'error');
        return;
    }

    navigator.clipboard.writeText(number).then(() => {
        showToast('GCash number copied to clipboard.', 'success');
    }).catch(() => {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = number;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('GCash number copied.', 'success');
    });
};

// Populate room dropdown for payment (Custom dropdown)
async function populatePaymentRoomDropdown(options = {}) {
    const config = options && typeof options === 'object' ? options : {};
    const sourceData = Array.isArray(config.sourceData) ? config.sourceData : null;
    const forceRefresh = config.forceRefresh === true;
    const optionsContainer = document.getElementById('room-select-options');
    if (!optionsContainer) return;

    // Get bills data
    let data = sourceData || window.publicBillsData;

    if (forceRefresh || !Array.isArray(data) || data.length === 0) {
        // Fetch fresh
        const result = await supabaseClient.rpc('get_public_bills');
        if (!result.error && result.data) {
            data = result.data;
            window.publicBillsData = data;
        }
    }

    // Store room data for amount lookup
    window.paymentRoomData = {};
    window.paymentRoomOptions = [];

    if (!data || data.length === 0) {
        optionsContainer.innerHTML = '<div class="custom-select-option room-option-empty">No rooms available</div>';
        return;
    }

    // Sort by room number
    data.sort((a, b) => a.room_no.localeCompare(b.room_no, undefined, { numeric: true }));

    data.forEach(room => {
        const amount = ((room.current_reading - room.previous_reading) * room.rate).toFixed(2);
        const normalizedStatus = String(room.status || 'DUE').toUpperCase() === 'PAID' ? 'PAID' : 'DUE';
        window.paymentRoomData[room.room_no] = { amount, status: normalizedStatus };
        window.paymentRoomOptions.push({
            room_no: room.room_no,
            amount,
            status: normalizedStatus
        });
    });

    renderPaymentRoomOptions();
    bindPaymentRoomDropdownEvents();
}

function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttrValue(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeRoomSearchValue(value) {
    return String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function normalizePaymentRoomDropdownLayout() {
    const optionsContainer = document.getElementById('room-select-options');
    if (!optionsContainer) return null;

    const searchBlock = optionsContainer.querySelector('.room-dropdown-search');
    const listBlock = optionsContainer.querySelector('.room-dropdown-list');
    if (!searchBlock || !listBlock) return null;

    // Ensure strict DOM order: search block first, list block second.
    if (optionsContainer.firstElementChild !== searchBlock) {
        optionsContainer.insertBefore(searchBlock, optionsContainer.firstElementChild);
    }
    if (searchBlock.nextElementSibling !== listBlock) {
        optionsContainer.insertBefore(listBlock, searchBlock.nextElementSibling);
    }

    // Reset visual offsets that can linger after mobile viewport changes.
    optionsContainer.scrollTop = 0;
    listBlock.scrollTop = 0;

    return { optionsContainer, searchBlock, listBlock };
}

function renderPaymentRoomOptions() {
    const optionsContainer = document.getElementById('room-select-options');
    if (!optionsContainer) return;

    const selectedInput = document.getElementById('payment-room-select');
    const selectedValue = selectedInput ? String(selectedInput.value || '') : '';
    const roomOptions = Array.isArray(window.paymentRoomOptions) ? window.paymentRoomOptions : [];

    const optionsMarkup = roomOptions.map((room) => {
        const statusClass = room.status === 'PAID' ? 'status-paid' : 'status-due';
        const statusLabel = room.status === 'PAID' ? 'PAID' : 'DUE';
        const encodedRoom = encodeURIComponent(String(room.room_no || ''));
        const searchText = `${room.room_no} ${statusLabel} ${room.amount}`.toLowerCase();
        const compactSearchText = normalizeRoomSearchValue(searchText);
        const isSelected = String(room.room_no) === selectedValue ? ' selected' : '';

        return `<div class="custom-select-option room-option-card ${statusClass}${isSelected}"
            data-action="select"
            data-value="${encodedRoom}"
            data-amount="${escapeAttrValue(room.amount)}"
            data-search="${escapeAttrValue(searchText)}"
            data-search-compact="${escapeAttrValue(compactSearchText)}">
            <span class="room-option-left">
                <span class="room-status-dot"></span>
                <span class="room-option-name">${escapeHtmlText(room.room_no)}</span>
            </span>
            <span class="room-option-right">
                <span class="room-option-amount">${formatCurrency(room.amount)}</span>
                <span class="room-option-status">${statusLabel}</span>
            </span>
        </div>`;
    }).join('');

    optionsContainer.innerHTML = `
        <div class="room-dropdown-search">
            <input type="text" id="room-select-search" class="room-search-input" placeholder="Search room..."
                autocomplete="off" />
        </div>
        <div class="room-dropdown-list" id="room-dropdown-list">
            <div class="custom-select-option room-option-reset${selectedValue ? '' : ' selected'}" data-action="reset">Clear selection</div>
            ${optionsMarkup}
            <div id="room-option-empty-filter" class="custom-select-option room-option-empty" style="display:none;">No matching rooms</div>
        </div>
    `;

    normalizePaymentRoomDropdownLayout();
}

function bindPaymentRoomDropdownEvents() {
    const optionsContainer = document.getElementById('room-select-options');
    if (!optionsContainer || optionsContainer.dataset.bound === '1') return;

    optionsContainer.dataset.bound = '1';

    optionsContainer.addEventListener('input', (event) => {
        if (event.target && event.target.id === 'room-select-search') {
            window.filterPaymentRoomDropdown(event.target.value);
        }
    });

    optionsContainer.addEventListener('click', (event) => {
        const option = event.target.closest('.custom-select-option[data-action]');
        if (!option || !optionsContainer.contains(option)) return;

        const action = option.getAttribute('data-action');
        if (action === 'reset') {
            window.selectPaymentRoom('', '-- Select Room --', '0.00');
            return;
        }

        if (action === 'select') {
            const encoded = option.getAttribute('data-value') || '';
            const amount = option.getAttribute('data-amount') || '0.00';
            const value = decodeURIComponent(encoded);
            window.selectPaymentRoom(value, value, amount);
        }
    });
}

window.filterPaymentRoomDropdown = function (query = '') {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const compactQuery = normalizeRoomSearchValue(normalizedQuery);
    const cards = document.querySelectorAll('#room-select-options .room-option-card[data-search]');
    const reset = document.querySelector('#room-select-options .room-option-reset');
    const emptyFilter = document.getElementById('room-option-empty-filter');

    let visibleCount = 0;
    cards.forEach(card => {
        const key = String(card.getAttribute('data-search') || '');
        const compactKey = String(card.getAttribute('data-search-compact') || normalizeRoomSearchValue(key));
        const match = !normalizedQuery
            || key.includes(normalizedQuery)
            || (compactQuery && compactKey.includes(compactQuery));
        card.style.display = match ? '' : 'none';
        if (match) visibleCount += 1;
    });

    if (reset) reset.style.display = normalizedQuery ? 'none' : '';
    if (emptyFilter) emptyFilter.style.display = visibleCount === 0 ? '' : 'none';

    normalizePaymentRoomDropdownLayout();
    updateRoomDropdownPlacement();
};

function focusPaymentRoomSearch() {
    const searchInput = document.getElementById('room-select-search');
    if (!searchInput) return;

    normalizePaymentRoomDropdownLayout();

    searchInput.value = '';
    window.filterPaymentRoomDropdown('');

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    if (!isMobile) {
        requestAnimationFrame(() => {
            searchInput.focus({ preventScroll: true });
        });
    }
}

function closeRoomDropdown() {
    const wrapper = document.querySelector('.custom-select-wrapper');
    const roomField = document.querySelector('.payfield-room');
    const trigger = document.getElementById('room-select-trigger');
    if (!wrapper) return;

    wrapper.classList.remove('open', 'open-up', 'open-down');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (!roomField) return;
    roomField.classList.remove('dropdown-open', 'dropdown-open-up', 'dropdown-open-down');
}

function updateRoomDropdownPlacement() {
    const wrapper = document.querySelector('.custom-select-wrapper');
    const roomField = document.querySelector('.payfield-room');
    const options = document.getElementById('room-select-options');
    if (!wrapper || !roomField || !options) return;

    wrapper.classList.remove('open-up', 'open-down');
    roomField.classList.remove('dropdown-open-up', 'dropdown-open-down');

    const isMobile = window.matchMedia('(max-width: 600px)').matches;
    const maxDropdownHeight = isMobile ? 150 : 176;
    const renderedHeight = Math.min(options.scrollHeight || 0, maxDropdownHeight);
    const wrapperRect = wrapper.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const spaceBelow = viewportHeight - wrapperRect.bottom - 12;
    const spaceAbove = wrapperRect.top - 12;
    const shouldOpenUp = spaceBelow < renderedHeight && spaceAbove > spaceBelow;

    if (isMobile) {
        if (shouldOpenUp) {
            wrapper.classList.add('open-up');
            roomField.classList.add('dropdown-open-up');
            return;
        }

        wrapper.classList.add('open-down');
        roomField.classList.add('dropdown-open-down');
        return;
    }

    if (shouldOpenUp) {
        wrapper.classList.add('open-up');
        roomField.classList.add('dropdown-open-up');
        return;
    }

    wrapper.classList.add('open-down');
    roomField.classList.add('dropdown-open-down');
}

// Toggle room dropdown
window.toggleRoomDropdown = async function () {
    const wrapper = document.querySelector('.custom-select-wrapper');
    const roomField = document.querySelector('.payfield-room');
    const trigger = document.getElementById('room-select-trigger');
    if (!wrapper) return;

    const willOpen = !wrapper.classList.contains('open');
    if (!willOpen) {
        closeRoomDropdown();
        return;
    }

    await populatePaymentRoomDropdown({ forceRefresh: true });

    wrapper.classList.add('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'true');
    if (roomField) roomField.classList.add('dropdown-open');
    normalizePaymentRoomDropdownLayout();
    updateRoomDropdownPlacement();
    focusPaymentRoomSearch();
};

// Select room from custom dropdown
window.selectPaymentRoom = function (value, text, amount) {
    const trigger = document.getElementById('room-select-text');
    const hiddenInput = document.getElementById('payment-room-select');

    if (trigger) trigger.textContent = text;
    if (hiddenInput) hiddenInput.value = value;
    closeRoomDropdown();

    // Update amount display
    const amountDisplay = document.getElementById('payment-amount');
    if (amountDisplay) {
        amountDisplay.textContent = value ? formatCurrency(amount || 0) : formatCurrency(0);
    }

    // Mark selected
    document.querySelectorAll('#room-select-options .custom-select-option').forEach(opt => opt.classList.remove('selected'));
    if (!value) {
        const resetOpt = document.querySelector('#room-select-options .room-option-reset');
        if (resetOpt) resetOpt.classList.add('selected');
    } else {
        const encoded = encodeURIComponent(String(value));
        const selectedOpt = document.querySelector(`#room-select-options .room-option-card[data-value="${encoded}"]`);
        if (selectedOpt) selectedOpt.classList.add('selected');
    }
};

// Close dropdown when clicking outside
document.addEventListener('click', function (e) {
    const wrapper = document.querySelector('.custom-select-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        closeRoomDropdown();
    }
});

window.addEventListener('resize', () => {
    const wrapper = document.querySelector('.custom-select-wrapper');
    if (wrapper && wrapper.classList.contains('open')) {
        updateRoomDropdownPlacement();
    }
});

function setupReceiptUploadZone() {
    const receiptInput = document.getElementById('receipt-upload');
    const uploadZone = document.getElementById('receipt-upload-zone');
    const fileNameLabel = document.getElementById('uploaded-file-name');
    const noteLabel = document.getElementById('receipt-validation-note');

    if (!receiptInput || !uploadZone) return;

    const setReceiptValidationNote = (message = '') => {
        const hasMessage = Boolean(message);
        uploadZone.classList.toggle('has-error', hasMessage);
        uploadZone.setAttribute('aria-invalid', hasMessage ? 'true' : 'false');
        if (noteLabel) {
            noteLabel.textContent = hasMessage ? message : '';
            noteLabel.classList.toggle('is-visible', hasMessage);
        }
    };

    window.showReceiptValidationNote = setReceiptValidationNote;

    const renderSelectedFile = () => {
        const selectedFile = receiptInput.files && receiptInput.files[0] ? receiptInput.files[0] : null;
        if (!selectedFile) {
            uploadZone.classList.remove('has-file');
            if (fileNameLabel) fileNameLabel.textContent = '';
            return;
        }

        uploadZone.classList.add('has-file');
        if (fileNameLabel) fileNameLabel.textContent = selectedFile.name;
        setReceiptValidationNote('');
    };

    receiptInput.addEventListener('change', renderSelectedFile);

    uploadZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        uploadZone.classList.add('is-dragging');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('is-dragging');
    });

    uploadZone.addEventListener('drop', (event) => {
        event.preventDefault();
        uploadZone.classList.remove('is-dragging');

        const droppedFile = event.dataTransfer?.files?.[0];
        if (!droppedFile) return;

        if (typeof DataTransfer === 'undefined') {
            showToast('Drag and drop is not supported in this browser.', 'info');
            return;
        }

        const transfer = new DataTransfer();
        transfer.items.add(droppedFile);
        receiptInput.files = transfer.files;
        renderSelectedFile();
    });

    renderSelectedFile();
}

setupReceiptUploadZone();

// Payment submission form handler
const paymentForm = document.getElementById('payment-submission-form');
if (paymentForm) {
    paymentForm.noValidate = true;
    paymentForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const senderGcash = document.getElementById('sender-gcash').value.trim();
        const senderName = document.getElementById('sender-name').value.trim();
        const senderContact = document.getElementById('sender-contact').value.trim();
        const roomNo = document.getElementById('payment-room-select').value;
        const amountText = document.getElementById('payment-amount').textContent;
        const amount = parseFloat(amountText.replace(/[^0-9.]/g, '')) || 0;
        const receiptFile = document.getElementById('receipt-upload').files[0];
        const receiptUploadZone = document.getElementById('receipt-upload-zone');
        const setReceiptNote = typeof window.showReceiptValidationNote === 'function'
            ? window.showReceiptValidationNote
            : () => {};

        // Validation
        if (!senderGcash || !senderName || !senderContact || !roomNo) {
            showToast('Please fill in all required fields.', 'error');
            return;
        }

        if (!receiptFile) {
            setReceiptNote('Please upload or attach your payment receipt.');
            showToast('Please upload or attach your payment receipt.', 'error');
            if (receiptUploadZone) {
                receiptUploadZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
                receiptUploadZone.focus({ preventScroll: true });
            }
            return;
        }
        setReceiptNote('');

        if (amount <= 0) {
            showToast('Invalid amount. Please select a valid room.', 'error');
            return;
        }

        // Disable submit button
        const submitBtn = paymentForm.querySelector('button[type="submit"]');
        const defaultSubmitHTML = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('is-loading');
            submitBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span>Submitting...</span>';
        }

        try {
            // Upload receipt image
            const fileName = `receipt_${Date.now()}_${receiptFile.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
            const { data: uploadData, error: uploadError } = await supabaseClient.storage
                .from('payment-assets')
                .upload(`receipts/${fileName}`, receiptFile, {
                    cacheControl: '3600',
                    upsert: false
                });

            if (uploadError) {
                throw new Error('Failed to upload receipt: ' + uploadError.message);
            }

            // Get public URL
            const { data: urlData } = supabaseClient.storage
                .from('payment-assets')
                .getPublicUrl(`receipts/${fileName}`);

            const receiptUrl = urlData.publicUrl;

            // Save to database
            const { data: submissionId, error: insertError } = await supabaseClient.rpc('submit_payment', {
                p_sender_gcash_number: senderGcash,
                p_sender_full_name: senderName,
                p_sender_contact_number: senderContact,
                p_room_no: roomNo,
                p_amount_to_pay: amount,
                p_receipt_image_url: receiptUrl
            });

            if (insertError) {
                throw new Error('Failed to submit payment: ' + insertError.message);
            }

            // Get detailed billing info
            let billDetails = {};
            if (window.publicBillsData) {
                const billRecord = window.publicBillsData.find(b => b.room_no === roomNo && b.status === 'DUE');
                if (billRecord) {
                    billDetails = {
                        periodStart: billRecord.period_start,
                        periodEnd: billRecord.period_end,
                        month: billRecord.month,
                        prevReading: billRecord.previous_reading,
                        currReading: billRecord.current_reading,
                        kwhUsed: (billRecord.current_reading - billRecord.previous_reading).toFixed(1),
                        rate: billRecord.rate
                    };
                }
            }

            // Send email notification via Edge Function
            try {
                const edgeFunctionUrl = `${SUPABASE_URL}/functions/v1/send-payment-email`;
                const emailRes = await fetch(edgeFunctionUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SUPABASE_KEY}`
                    },
                    body: JSON.stringify({
                        senderName,
                        senderGcash,
                        senderContact,
                        roomNo,
                        amount: amount.toFixed(2),
                        receiptUrl,
                        ...billDetails // Spread detailed info
                    })
                });

                if (!emailRes.ok) {
                    const errorData = await emailRes.json();
                    console.warn('Email service warning:', errorData);
                    showToast('Payment submitted, but email notification failed.', 'info');
                }

            } catch (emailErr) {
                console.error('Email notification failed:', emailErr);
                showToast('Payment submitted, but email notification failed.', 'info');
            }

            // Success!
            showToast('Payment submitted successfully. Please wait 5-30 minutes for review.', 'success');

            // Reset form
            paymentForm.reset();
            document.getElementById('payment-amount').textContent = formatCurrency(0);
            const fileNameEl = document.getElementById('uploaded-file-name');
            if (fileNameEl) fileNameEl.textContent = '';
            const uploadZone = document.getElementById('receipt-upload-zone');
            if (uploadZone) uploadZone.classList.remove('has-file');
            const setReceiptNote = typeof window.showReceiptValidationNote === 'function'
                ? window.showReceiptValidationNote
                : () => {};
            setReceiptNote('');
            const roomText = document.getElementById('room-select-text');
            if (roomText) roomText.textContent = '-- Select Room --';
            document.querySelectorAll('.custom-select-option').forEach(opt => opt.classList.remove('selected'));

        } catch (err) {
            console.error('Payment submission error:', err);
            showToast(err.message || 'Failed to submit payment. Please try again.', 'error');
        } finally {
            // Re-enable submit button
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.classList.remove('is-loading');
                submitBtn.innerHTML = defaultSubmitHTML || 'Submit Payment';
            }
        }
    });
}

// Initialize payment system on page load
document.addEventListener('DOMContentLoaded', () => {
    // Load payment settings for display
    setTimeout(() => {
        loadPaymentSettings();
        populatePaymentRoomDropdown({ forceRefresh: true });
        refreshBillingLiveData(true);
    }, 500); // Slight delay to ensure Supabase is initialized
});

// Also load when public bills are fetched
const originalFetchPublicBills = window.fetchPublicBills || fetchPublicBills;
window.fetchPublicBills = async function (...args) {
    const data = await originalFetchPublicBills.apply(this, args);
    if (Array.isArray(data)) {
        await populatePaymentRoomDropdown({ sourceData: data });
    }
    return data;
};

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshBillingLiveData(true);
    }
});



