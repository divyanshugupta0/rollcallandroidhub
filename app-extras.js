// No map SDK needed - removed

(function () {
    function hideLoader() {
        const loader = document.getElementById('page-loader');
        if (!loader) {
            return;
        }
        loader.classList.add('loader-hidden');
        // Remove loader from DOM after animation completes
        setTimeout(function () {
            if (loader.parentNode) {
                loader.parentNode.removeChild(loader);
            }
        }, 500);
    }

    function scheduleHide(delay) {
        setTimeout(hideLoader, delay);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        scheduleHide(400);
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            scheduleHide(400);
        }, { once: true });
    }

    window.addEventListener('load', function () {
        scheduleHide(400);
    }, { once: true });

    // Fallback: hide loader even if some external resources never finish loading
    setTimeout(hideLoader, 4000);
})();

// Add notification functionality after DOM is loaded
        document.addEventListener('DOMContentLoaded', function () {
            let notificationIntervalId = null;
            let notificationListenerQuery = null;
            let notificationListenerCallback = null;
            let notificationListenerUserId = null;

            // Initialize Firebase
            const firebaseConfig = {
                apiKey: "AIzaSyD_An-qb0XTLpaLdrOftAEOqsshGpPbv1w",
                authDomain: "firefly-64eef.firebaseapp.com",
                databaseURL: "https://firefly-64eef-default-rtdb.asia-southeast1.firebasedatabase.app",
                projectId: "firefly-64eef",
                storageBucket: "firefly-64eef.firebasestorage.app",
                messagingSenderId: "563239732954",
                appId: "1:563239732954:web:1774bfd1f7aceedeb707e3",
                measurementId: "G-RKL3BV2H03"
            };

            // Initialize Firebase if not already initialized
            if (typeof firebase !== 'undefined' && !firebase.apps.length) {
                firebase.initializeApp(firebaseConfig);
                console.log("Firebase initialized for notifications");
            }

            function getNotificationStorage() {
                if (window.safeStorage && typeof window.safeStorage.getItem === 'function') {
                    return window.safeStorage;
                }
                try {
                    const testKey = '__rollcall_notify_test__';
                    localStorage.setItem(testKey, '1');
                    localStorage.removeItem(testKey);
                    return localStorage;
                } catch (e) {
                    return null;
                }
            }

            function sendNativeNotification(notification) {
                const title = String(notification.header || 'New Notification');
                const body = String(notification.body || '');

                if (typeof window.rollcallNotifyNative === 'function') {
                    try {
                        return window.rollcallNotifyNative(title, body) === true;
                    } catch (error) {
                        console.warn('rollcallNotifyNative failed:', error);
                    }
                }

                function attemptNotify(remainingAttempts) {
                    try {
                        if (window.AndroidDevice) {
                            if (typeof window.AndroidDevice.showNotification === 'function') {
                                window.AndroidDevice.showNotification(title, body);
                                return true;
                            }
                            if (typeof window.AndroidDevice.notify === 'function') {
                                window.AndroidDevice.notify(title, body);
                                return true;
                            }
                            if (typeof window.AndroidDevice.sendNotification === 'function') {
                                window.AndroidDevice.sendNotification(title, body);
                                return true;
                            }
                        }
                    } catch (error) {
                        console.warn('Native notification failed:', error);
                    }

                    if (remainingAttempts > 0) {
                        setTimeout(() => attemptNotify(remainingAttempts - 1), 500);
                    }
                    return false;
                }

                return attemptNotify(3);
            }

            function handleNotificationCandidate(notification, notificationId, studentId) {
                if (!notification || !notificationId || !notification.recipients) {
                    return;
                }

                if (!(notification.recipients[0] === 'all' ||
                    notification.recipients.includes(studentId))) {
                    return;
                }

                const notificationKey = `notification_${notificationId}`;
                const notificationStorage = getNotificationStorage();
                const lastShown = notificationStorage ? notificationStorage.getItem(notificationKey) : null;

                if (lastShown) {
                    return;
                }

                if (!document.hidden) {
                    showNotificationPopup(notification, notificationId);
                }

                sendNativeNotification(notification);

                if (notificationStorage) {
                    notificationStorage.setItem(notificationKey, Date.now());
                }

                if (typeof loadNotifications === 'function') {
                    loadNotifications();
                }
            }

            function startNotificationListener(studentId) {
                if (!studentId) return;
                if (notificationListenerUserId === studentId && notificationListenerQuery) {
                    return;
                }

                stopNotificationListener();
                notificationListenerUserId = studentId;

                const db = firebase.database();
                const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                notificationListenerQuery = db.ref('notifications')
                    .orderByChild('timestamp')
                    .startAt(oneWeekAgo);

                notificationListenerCallback = (snapshot) => {
                    const notification = snapshot.val();
                    const notificationId = snapshot.key;
                    handleNotificationCandidate(notification, notificationId, studentId);
                };

                notificationListenerQuery.on('child_added', notificationListenerCallback, (error) => {
                    console.error('Notification listener error:', error);
                });
            }

            function stopNotificationListener() {
                if (notificationListenerQuery && notificationListenerCallback) {
                    notificationListenerQuery.off('child_added', notificationListenerCallback);
                }
                notificationListenerQuery = null;
                notificationListenerCallback = null;
                notificationListenerUserId = null;
            }

            // Wait for auth state to be ready
            firebase.auth().onAuthStateChanged(function (user) {
                if (user) {
                    // User is signed in, start checking for notifications
                    console.log("User logged in, will check for notifications");
                    setTimeout(checkForNotifications, 2000);

                    // Check for new notifications every 5 minutes
                    if (notificationIntervalId) {
                        clearInterval(notificationIntervalId);
                    }
                    notificationIntervalId = setInterval(checkForNotifications, 5 * 60 * 1000);

                    startNotificationListener(user.uid);
                } else {
                    // No user is signed in
                    console.log("No user logged in, notifications will not be checked");
                    if (notificationIntervalId) {
                        clearInterval(notificationIntervalId);
                        notificationIntervalId = null;
                    }
                    stopNotificationListener();
                }
            });

            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    checkForNotifications();
                }
            });

            // Function to check for new notifications
            function checkForNotifications() {
                // Get current user
                const currentUser = firebase.auth().currentUser;

                if (!currentUser) {
                    console.log("User not logged in, skipping notification check");
                    return;
                }

                const userId = currentUser.uid;
                const db = firebase.database();

                console.log("Checking notifications for user:", userId);

                // Get user info to check role
                db.ref(`users/${userId}`).once('value')
                    .then(snapshot => {
                        if (snapshot.exists()) {
                            const userData = snapshot.val();

                            console.log("User role:", userData.role);

                            if (userData.role === 'student') {
                                // Check for notifications for this student
                                checkStudentNotifications(userId);
                            }
                        } else {
                            console.log("User data not found");
                        }
                    })
                    .catch(error => {
                        console.error("Error checking user data:", error);
                    });
            }

            // Function to check student notifications
            function checkStudentNotifications(studentId) {
                const db = firebase.database();

                console.log("Checking notifications for student:", studentId);

                // Check student notifications - get all notifications from the last 7 days
                const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

                db.ref('notifications')
                    .orderByChild('timestamp')
                    .startAt(oneWeekAgo)
                    .once('value')
                    .then(snapshot => {
                        console.log("Notifications query complete");

                        if (snapshot.exists()) {
                            const notifications = snapshot.val();
                            console.log("Found notifications:", Object.keys(notifications).length);

                            // Process each notification
                            Object.keys(notifications).forEach(notificationId => {
                                const notification = notifications[notificationId];

                                // Make sure the notification has recipients field
                                if (!notification.recipients) {
                                    console.log("Notification has no recipients field:", notificationId);
                                    return;
                                }

                                console.log("Checking notification:", notificationId, "Recipients:", notification.recipients);

                                // Check if this notification is for all students or specifically for this student
                                if (notification.recipients[0] === 'all' ||
                                    notification.recipients.includes(studentId)) {

                                    console.log("Notification is for this student:", notificationId);

                                    // Check if we've already shown this notification
                                    const notificationKey = `notification_${notificationId}`;
                                    const notificationStorage = getNotificationStorage();
                                    const lastShown = notificationStorage ? notificationStorage.getItem(notificationKey) : null;

                                    if (!lastShown) {
                                        console.log("Showing notification:", notificationId);

                                        // Show the notification
                                        if (!document.hidden) {
                                            showNotificationPopup(notification, notificationId);
                                        }
                                        sendNativeNotification(notification);

                                        // Mark as shown
                                        if (notificationStorage) {
                                            notificationStorage.setItem(notificationKey, Date.now());
                                        }
                                        if (typeof loadNotifications === 'function') {
                                            loadNotifications();
                                        }
                                    } else {
                                        console.log("Notification already shown:", notificationId, "at", new Date(parseInt(lastShown)));
                                    }
                                } else {
                                    console.log("Notification is not for this student");
                                }
                            });
                        } else {
                            console.log("No notifications found");
                        }
                    })
                    .catch(error => {
                        console.error("Error checking notifications:", error);
                    });
            }

            // Function to show notification popup
            function showNotificationPopup(notification, notificationId) {
                const container = document.getElementById('notification-popup-container');
                if (!container) {
                    console.error("Notification container not found");
                    return;
                }

                console.log("Creating notification popup for:", notification.header);

                // Create notification element
                const notificationEl = document.createElement('div');
                notificationEl.className = 'notification-popup';
                notificationEl.id = `notification-popup-${notificationId}`;

                // Format date
                const date = new Date(notification.timestamp);
                const formattedDate = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

                notificationEl.innerHTML = `
                    <div class="notification-popup-header">
                        ${notification.header || 'New Notification'}
                        <button class="notification-popup-close">&times;</button>
                    </div>
                    <div class="notification-popup-body">
                        ${notification.body || ''}
                    </div>
                    <div class="notification-popup-footer">
                        <span>Sent: ${formattedDate}</span>
                    </div>
                `;

                // Add to container
                container.appendChild(notificationEl);

                // Add close button event
                notificationEl.querySelector('.notification-popup-close').addEventListener('click', function () {
                    closeNotificationPopup(notificationId);
                });

                // Show with animation
                setTimeout(() => {
                    notificationEl.classList.add('show');
                }, 100);

                // Auto close after 15 seconds
                setTimeout(() => {
                    closeNotificationPopup(notificationId);
                }, 15000);
            }

            // Function to close notification popup
            function closeNotificationPopup(notificationId) {
                const notificationEl = document.getElementById(`notification-popup-${notificationId}`);
                if (!notificationEl) return;

                // Hide with animation
                notificationEl.classList.remove('show');

                // Remove after animation
                setTimeout(() => {
                    notificationEl.remove();
                }, 300);
            }
        });

const notificationBtn = document.getElementById('notifications-btn');
        const profileBtn = document.getElementById('profile-btn');
        const notificationBadge = document.querySelector('.notification-badge');
        const notificationModal = document.getElementById('notification-modal');
        const profileModal = document.getElementById('profile-modal');
        const updateRequestModal = document.getElementById('update-request-modal');
        const notificationModalClose = document.getElementById('notification-modal-close');
        const profileModalClose = document.getElementById('profile-modal-close');
        const updateRequestModalClose = document.getElementById('update-request-modal-close');
        const editProfileBtn = document.getElementById('edit-profile-btn');
        const requestUpdateBtn = document.getElementById('request-update-btn');
        const cancelEditBtn = document.getElementById('cancel-edit-btn');
        const confirmUpdateRequestBtn = document.getElementById('confirm-update-request');
        const cancelUpdateRequestBtn = document.getElementById('cancel-update-request');
        const notificationsContainer = document.getElementById('notifications-container');
        const profileContainer = document.getElementById('profile-container');
        const changesSummary = document.getElementById('changes-summary');

        // Profile fields
        const profileName = document.getElementById('profile-name');
        const profileEmail = document.getElementById('profile-email');
        const profileMobile = document.getElementById('profile-mobile');
        const profileRoll = document.getElementById('profile-roll');
        const profileUnivRoll = document.getElementById('profile-univ-roll');
        const profileSection = document.getElementById('profile-section');
        const profileCourse = document.getElementById('profile-course');

        // Profile inputs
        const profileNameInput = document.getElementById('profile-name-input');
        const profileEmailInput = document.getElementById('profile-email-input');
        const profileMobileInput = document.getElementById('profile-mobile-input');
        const profileRollInput = document.getElementById('profile-roll-input');
        const profileUnivRollInput = document.getElementById('profile-univ-roll-input');
        const profileSectionInput = document.getElementById('profile-section-input');
        const profileCourseInput = document.getElementById('profile-course-input');
        const profileUpdateCredit = document.getElementById('profile-update-credit');

        const PROFILE_UPDATE_LIMIT = 3;
        let profileUpdateCreditsRemaining = null;

        function updateProfileCreditUI(remaining) {
            if (!profileUpdateCredit) return;
            if (remaining === null || remaining === undefined) {
                profileUpdateCredit.textContent = '';
                return;
            }
            profileUpdateCredit.textContent = `Update credits left: ${remaining}/${PROFILE_UPDATE_LIMIT}`;
            profileUpdateCredit.style.color = remaining <= 0 ? '#ef4444' : '#64748b';
        }

        function refreshRequestUpdateButtonState() {
            if (!requestUpdateBtn) return;
            const limitReached = profileUpdateCreditsRemaining !== null && profileUpdateCreditsRemaining <= 0;
            requestUpdateBtn.disabled = limitReached;
            requestUpdateBtn.title = limitReached ? 'Update limit reached' : '';
        }

        function applyProfileCreditsFromUserData(userData) {
            const used = Number(userData?.profileUpdateUsed || 0);
            profileUpdateCreditsRemaining = Math.max(PROFILE_UPDATE_LIMIT - used, 0);
            updateProfileCreditUI(profileUpdateCreditsRemaining);
            refreshRequestUpdateButtonState();
        }

        function consumeProfileUpdateCredit(userId) {
            const db = firebase.database();
            const usedRef = db.ref(`users/${userId}/profileUpdateUsed`);
            return usedRef.transaction(current => {
                const used = Number(current || 0);
                if (used >= PROFILE_UPDATE_LIMIT) {
                    return; // abort transaction
                }
                return used + 1;
            }).then(result => {
                if (!result.committed) {
                    throw new Error('limit_reached');
                }
                const used = Number(result.snapshot.val() || 0);
                profileUpdateCreditsRemaining = Math.max(PROFILE_UPDATE_LIMIT - used, 0);
                updateProfileCreditUI(profileUpdateCreditsRemaining);
                refreshRequestUpdateButtonState();
            });
        }

        function releaseProfileUpdateCredit(userId) {
            const db = firebase.database();
            const usedRef = db.ref(`users/${userId}/profileUpdateUsed`);
            return usedRef.transaction(current => {
                const used = Number(current || 0);
                if (used <= 0) return used;
                return used - 1;
            }).then(result => {
                const used = Number(result.snapshot.val() || 0);
                profileUpdateCreditsRemaining = Math.max(PROFILE_UPDATE_LIMIT - used, 0);
                updateProfileCreditUI(profileUpdateCreditsRemaining);
                refreshRequestUpdateButtonState();
            });
        }

        if (profileSectionInput) {
            profileSectionInput.addEventListener('input', () => {
                profileSectionInput.value = profileSectionInput.value.toUpperCase();
            });
        }

        // Original profile data
        let originalProfileData = {};

        // Toggle modals
        function toggleModal(modal) {
            modal.classList.toggle('visible');
        }

        // Notification button click
        if(notificationBtn) notificationBtn.addEventListener('click', () => {
            toggleModal(notificationModal);
            loadNotifications();
        });

        // Profile button click
        if(profileBtn) profileBtn.addEventListener('click', () => {
            toggleModal(profileModal);
            loadProfileData();
        });

        // Close buttons
        if(notificationModalClose) notificationModalClose.addEventListener('click', () => toggleModal(notificationModal));
        if(profileModalClose) profileModalClose.addEventListener('click', () => toggleModal(profileModal));
        if(updateRequestModalClose) updateRequestModalClose.addEventListener('click', () => toggleModal(updateRequestModal));

        // Close modals when clicking outside
        [notificationModal, profileModal, updateRequestModal].forEach(modal => {
            if(modal) modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    toggleModal(modal);
                }
            });
        });

        // Edit Profile Photo Logic
        let editedProfilePhotoFile = null;

        function handleEditProfileImageUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            // Basic validation
            if (!file.type.startsWith('image/')) {
                alert('Please select a valid image file');
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                alert('Image size must be less than 2MB');
                return;
            }

            editedProfilePhotoFile = file;

            const reader = new FileReader();
            reader.onload = function (e) {
                const previewUrl = e.target.result;
                document.getElementById('edit-profile-preview').src = previewUrl;
            };
            reader.readAsDataURL(file);
        }
        window.handleEditProfileImageUpload = handleEditProfileImageUpload;

        // Load profile data
        function loadProfileData() {
            console.log('Loading profile data...');

            firebase.auth().onAuthStateChanged(function (user) {
                if (user) {
                    const db = firebase.database();
                    const userRef = db.ref('users/' + user.uid);

                    userRef.once('value').then(function (snapshot) {
                        const userData = snapshot.val();
                        if (userData) {
                            console.log('User data loaded:', userData);

                            // Store original data
                            originalProfileData = {
                                name: userData.name || '',
                                email: userData.email || user.email || '',
                                mobile: userData.mobile || '',
                                classRoll: userData.classRoll || '',
                                univRoll: userData.univRoll || '', // Add University Roll No.
                                section: userData.section || '',
                                course: userData.course || '',
                                profilePhoto: userData.profilePhoto || null // Store profile photo
                            };
                            applyProfileCreditsFromUserData(userData);

                            // Set profile image
                            const defaultImg = 'https://cdn.pixabay.com/photo/2016/11/14/17/39/person-1824144_960_720.png';
                            document.getElementById('edit-profile-preview').src = originalProfileData.profilePhoto || defaultImg;

                            // Display in profile fields
                            profileName.textContent = originalProfileData.name;
                            profileEmail.textContent = originalProfileData.email;
                            profileMobile.textContent = originalProfileData.mobile;
                            profileRoll.textContent = originalProfileData.classRoll; // Changed from roll to classRoll
                            profileUnivRoll.textContent = originalProfileData.univRoll; // Add University Roll No.
                            profileSection.textContent = originalProfileData.section;
                            profileCourse.textContent = originalProfileData.course;

                            // Set input values
                            profileNameInput.value = originalProfileData.name;
                            profileEmailInput.value = originalProfileData.email;
                            profileMobileInput.value = originalProfileData.mobile;
                            profileRollInput.value = originalProfileData.classRoll; // Changed from roll to classRoll
                            profileUnivRollInput.value = originalProfileData.univRoll; // Add University Roll No.
                            profileSectionInput.value = originalProfileData.section;
                            profileCourseInput.value = originalProfileData.course;
                            refreshRequestUpdateButtonState();
                        } else {
                            console.log('No user data found');
                        }
                    }).catch(function (error) {
                        console.error('Error loading profile data:', error);
                    });
                } else {
                    console.log('User not authenticated');
                }
            });
        }

        // Edit profile
        if (editProfileBtn) editProfileBtn.addEventListener('click', () => {
            profileContainer.classList.add('edit-mode');
            editProfileBtn.style.display = 'none';
            requestUpdateBtn.style.display = 'block';
            cancelEditBtn.style.display = 'block';

            // Show photo overlay
            document.getElementById('edit-profile-overlay').style.display = 'flex';
            document.getElementById('edit-profile-preview-wrapper').style.cursor = 'pointer';
        });

        // Cancel edit
        if(cancelEditBtn) cancelEditBtn.addEventListener('click', () => {
            profileContainer.classList.remove('edit-mode');
            editProfileBtn.style.display = 'block';
            requestUpdateBtn.style.display = 'none';
            cancelEditBtn.style.display = 'none';

            // Hide photo overlay & reset photo
            document.getElementById('edit-profile-overlay').style.display = 'none';
            document.getElementById('edit-profile-preview-wrapper').style.cursor = 'default';
            const defaultImg = 'https://cdn.pixabay.com/photo/2016/11/14/17/39/person-1824144_960_720.png';
            document.getElementById('edit-profile-preview').src = originalProfileData.profilePhoto || defaultImg;
            editedProfilePhotoFile = null;

            // Reset input values
            profileNameInput.value = originalProfileData.name;
            profileEmailInput.value = originalProfileData.email;
            profileMobileInput.value = originalProfileData.mobile;
            profileRollInput.value = originalProfileData.classRoll; // Changed from roll to classRoll
            profileUnivRollInput.value = originalProfileData.univRoll; // Add University Roll No.
            profileSectionInput.value = originalProfileData.section;
            profileCourseInput.value = originalProfileData.course;
            refreshRequestUpdateButtonState();
        });

        // Request update
        if(requestUpdateBtn) requestUpdateBtn.addEventListener('click', () => {
            // Get edited values
            const hasUpdatedProfilePhoto = !!editedProfilePhotoFile;
            const updatedData = {
                name: profileNameInput.value.trim(),
                email: profileEmailInput.value.trim(),
                mobile: profileMobileInput.value.trim(),
                classRoll: profileRollInput.value.trim(), // Changed from roll to classRoll
                univRoll: profileUnivRollInput.value.trim(), // Add University Roll No.
                section: profileSectionInput.value.trim(),
                course: profileCourseInput.value.trim(),
                profilePhoto: null,
                profilePhotoKey: null
            };

            if (profileUpdateCreditsRemaining !== null && profileUpdateCreditsRemaining <= 0) {
                showToast('Update limit reached');
                return;
            }

            // Check if any changes were made
            const changes = [];
            if (hasUpdatedProfilePhoto) {
                changes.push(`Profile Photo: Updated`);
            }
            if (updatedData.name !== originalProfileData.name) {
                changes.push(`Name: ${originalProfileData.name} → ${updatedData.name}`);
            }
            if (updatedData.email !== originalProfileData.email) {
                changes.push(`Email: ${originalProfileData.email} → ${updatedData.email}`);
            }
            if (updatedData.mobile !== originalProfileData.mobile) {
                changes.push(`Mobile: ${originalProfileData.mobile} → ${updatedData.mobile}`);
            }
            if (updatedData.classRoll !== originalProfileData.classRoll) {
                changes.push(`Class Roll No.: ${originalProfileData.classRoll} → ${updatedData.classRoll}`);
            }
            if (updatedData.univRoll !== originalProfileData.univRoll) {
                changes.push(`University Roll No.: ${originalProfileData.univRoll} → ${updatedData.univRoll}`);
            }
            if (updatedData.section !== originalProfileData.section) {
                changes.push(`Section: ${originalProfileData.section} -> ${updatedData.section}`);
            }
            if (updatedData.course !== originalProfileData.course) {
                changes.push(`Course: ${originalProfileData.course} → ${updatedData.course}`);
            }

            if (changes.length === 0) {
                showToast('No changes detected');
                return;
            }

            // Show confirmation modal with changes
            changesSummary.innerHTML = changes.map(change => `<div>${change}</div>`).join('');
            toggleModal(updateRequestModal);
        });

        // Confirm update request
        if(confirmUpdateRequestBtn) confirmUpdateRequestBtn.addEventListener('click', async () => {
            const user = firebase.auth().currentUser;
            if (!user) {
                showToast('User not authenticated');
                return;
            }

            if (profileUpdateCreditsRemaining !== null && profileUpdateCreditsRemaining <= 0) {
                showToast('Update limit reached');
                return;
            }

            const db = firebase.database();
            const updatesRef = db.ref('profile_update_requests');

            const updatedData = {
                name: profileNameInput.value.trim(),
                email: profileEmailInput.value.trim(),
                mobile: profileMobileInput.value.trim(),
                classRoll: profileRollInput.value.trim(), // Changed from roll to classRoll
                univRoll: profileUnivRollInput.value.trim(), // Add University Roll No.
                section: profileSectionInput.value.trim(),
                course: profileCourseInput.value.trim(),
                profilePhoto: null,
                profilePhotoKey: null
            };

            if (editedProfilePhotoFile) {
                try {
                    const uploadResult = await uploadProfilePhoto(editedProfilePhotoFile, user.uid);
                    updatedData.profilePhoto = uploadResult.publicUrl;
                    updatedData.profilePhotoKey = uploadResult.key || null;
                } catch (error) {
                    console.error('Profile photo upload failed:', error);
                    showToast('Profile photo upload failed');
                    return;
                }
            }

            try {
                await consumeProfileUpdateCredit(user.uid);
            } catch (error) {
                showToast('Update limit reached');
                return;
            }

            try {
                await updatesRef.push({
                    userId: user.uid,
                    currentData: originalProfileData,
                    requestedData: updatedData,
                    timestamp: firebase.database.ServerValue.TIMESTAMP,
                    status: 'pending'
                });
                showToast('Update request submitted successfully');
                toggleModal(updateRequestModal);
                toggleModal(profileModal);
                profileContainer.classList.remove('edit-mode');
                editProfileBtn.style.display = 'block';
                requestUpdateBtn.style.display = 'none';
                cancelEditBtn.style.display = 'none';
            } catch (error) {
                console.error('Error submitting update request:', error);
                showToast('Failed to submit update request');
                await releaseProfileUpdateCredit(user.uid);
            }
        });

        // Cancel update request
        if(cancelUpdateRequestBtn) cancelUpdateRequestBtn.addEventListener('click', () => {
            toggleModal(updateRequestModal);
        });

        // Load notifications
        function loadNotifications() {
            console.log('Loading notifications...');

            // Show loading state
            notificationsContainer.innerHTML = `
            <div class="loading-state" style="text-align: center; padding: 20px;">
              <i class="fas fa-spinner fa-spin" style="font-size: 2rem; color: var(--primary-color); margin-bottom: 10px;"></i>
              <p>Loading notifications...</p>
            </div>
          `;

            // Use a promise-based approach to be more reliable
            const getCurrentUser = () => {
                return new Promise((resolve, reject) => {
                    const unsubscribe = firebase.auth().onAuthStateChanged(user => {
                        unsubscribe();
                        if (user) {
                            resolve(user);
                        } else {
                            reject(new Error('User not authenticated'));
                        }
                    });
                });
            };

            getCurrentUser()
                .then(user => {
                    const db = firebase.database();
                    const notificationsRef = db.ref('notifications');
                    return notificationsRef.orderByChild('timestamp').once('value').then(snapshot => {
                        return { user, snapshot };
                    });
                })
                .then(({ user, snapshot }) => {
                    const notifications = [];
                    let totalCount = 0;

                    snapshot.forEach(function (childSnapshot) {
                        totalCount++;
                        const notification = childSnapshot.val();

                        // Show all notifications
                        notifications.push({
                            id: childSnapshot.key,
                            ...notification,
                            read: notification.readBy && notification.readBy[user.uid] ? true : false
                        });
                    });

                    console.log(`Found ${totalCount} total notifications, showing ${notifications.length} to user`);

                    // Sort notifications by timestamp in descending order (newest first)
                    notifications.sort((a, b) => b.timestamp - a.timestamp);

                    // Update UI
                    displayNotifications(notifications);

                    // Update notification badge
                    updateNotificationBadge(notifications);
                })
                .catch(error => {
                    console.error('Error loading notifications:', error);
                    notificationsContainer.innerHTML = `
                      <div class="empty-state">
                          <i class="fas fa-exclamation-circle" style="font-size: 2rem; opacity: 0.3; margin-bottom: 10px;"></i>
                          <p>Error loading notifications</p>
                          <p style="font-size: 0.85rem; margin-top: 10px;">${error.message}</p>
                      </div>
                  `;
                });
        }

        // Display notifications
        function displayNotifications(notifications) {
            if (notifications.length === 0) {
                notificationsContainer.innerHTML = `
              <div class="empty-state">
                <i class="fas fa-bell" style="font-size: 2rem; opacity: 0.3; margin-bottom: 10px;"></i>
                <p>No notifications yet</p>
              </div>
            `;
                return;
            }

            const unreadCount = notifications.filter(n => !n.read).length;

            // Only show header bar if there are unread notifications
            let headerHtml = '';
            if (unreadCount > 0) {
                headerHtml = `
                    <div class="notification-header-bar">
                      <span><strong>${unreadCount}</strong> New Notification${unreadCount !== 1 ? 's' : ''}</span>
                      <button id="mark-all-read-btn" class="btn-text">Mark all as read</button>
                    </div>`;
            }

            notificationsContainer.innerHTML = `
            ${headerHtml}
            <div class="notification-list"></div>
          `;

            const notificationList = notificationsContainer.querySelector('.notification-list');

            notifications.forEach(notification => {
                const notificationEl = document.createElement('div');
                notificationEl.className = `notification-item ${notification.read ? '' : 'unread'}`;
                notificationEl.dataset.id = notification.id;

                const date = new Date(notification.timestamp);
                const formattedDate = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();

                notificationEl.innerHTML = `
              <div class="notification-header">${notification.header || 'New Notification'}</div>
              <div class="notification-time">${formattedDate}</div>
              <div class="notification-content">${notification.body}</div>
            `;

                notificationEl.addEventListener('click', () => {
                    // Mark notification as read
                    markNotificationAsRead(notification.id);

                    // Update UI state immediately
                    if (notificationEl.classList.contains('unread')) {
                        notificationEl.classList.remove('unread');

                        // Check if any unread remain
                        const remainingUnread = notificationList.querySelectorAll('.notification-item.unread').length;
                        if (remainingUnread === 0) {
                            const header = notificationsContainer.querySelector('.notification-header-bar');
                            if (header) header.style.display = 'none';
                        } else {
                            // Update count in header
                            const headerCount = notificationsContainer.querySelector('.notification-header-bar strong');
                            if (headerCount) headerCount.textContent = remainingUnread;

                            const headerText = notificationsContainer.querySelector('.notification-header-bar span');
                            if (headerText) headerText.innerHTML = `<strong>${remainingUnread}</strong> New Notification${remainingUnread !== 1 ? 's' : ''}`;
                        }
                    }

                    // Update notification badge
                    if (!notification.read) {
                        notification.read = true;
                        updateNotificationBadge(notifications);
                    }
                });

                notificationList.appendChild(notificationEl);
            });

            // Add mark all as read functionality
            const markAllReadBtn = document.getElementById('mark-all-read-btn');
            if (markAllReadBtn) {
                markAllReadBtn.addEventListener('click', () => {
                    markAllNotificationsAsRead(notifications);
                    // Hide header immediately
                    const header = notificationsContainer.querySelector('.notification-header-bar');
                    if (header) header.style.display = 'none';
                });
            }
        }

        // Mark all notifications as read
        function markAllNotificationsAsRead(notifications) {
            firebase.auth().onAuthStateChanged(function (user) {
                if (user) {
                    const db = firebase.database();
                    const updates = {};

                    notifications.forEach(notification => {
                        if (!notification.read) {
                            updates[`notifications/${notification.id}/readBy/${user.uid}`] = true;
                            notification.read = true;
                        }
                    });

                    // Only update if there are unread notifications
                    if (Object.keys(updates).length > 0) {
                        db.ref().update(updates)
                            .then(() => {
                                console.log('All notifications marked as read');

                                // Update UI
                                document.querySelectorAll('.notification-item.unread').forEach(el => {
                                    el.classList.remove('unread');
                                });

                                // Update badge
                                updateNotificationBadge(notifications);
                            })
                            .catch(function (error) {
                                console.error('Error marking notifications as read:', error);
                            });
                    }
                }
            });
        }

        // Show notification detail
        function showNotificationDetail(notification, element) {
            // Remove existing detail
            const existingDetail = notificationsContainer.querySelector('.notification-detail');
            if (existingDetail) {
                existingDetail.remove();
            }

            // Create detail element
            const detailEl = document.createElement('div');
            detailEl.className = 'notification-detail';
            detailEl.innerHTML = notification.body;

            // Insert after the clicked notification
            element.after(detailEl);

            // Mark as read in UI
            element.classList.remove('unread');

            // Update notification badge
            loadNotifications();
        }

        // Mark notification as read
        function markNotificationAsRead(notificationId) {
            firebase.auth().onAuthStateChanged(function (user) {
                if (user) {
                    const db = firebase.database();
                    const updates = {};
                    updates[`notifications/${notificationId}/readBy/${user.uid}`] = true;

                    db.ref().update(updates).catch(function (error) {
                        console.error('Error marking notification as read:', error);
                    });
                }
            });
        }

        // Update notification badge
        function updateNotificationBadge(notifications) {
            const unreadCount = notifications.filter(n => !n.read).length;

            if (unreadCount > 0) {
                notificationBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                notificationBadge.style.display = 'flex';
            } else {
                notificationBadge.style.display = 'none';
            }
        }

        // Show toast message
        function showToast(message) {
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = message;
            document.body.appendChild(toast);

            setTimeout(() => {
                toast.classList.add('show');
                setTimeout(() => {
                    toast.classList.remove('show');
                    setTimeout(() => {
                        toast.remove();
                    }, 300);
                }, 3000);
            }, 100);
        }

// Forgot password functionality
        document.getElementById('forgot-password-link').addEventListener('click', function (e) {
            e.preventDefault();
            openForgotPasswordModal();
        });

        function openForgotPasswordModal() {
            document.getElementById('forgot-password-modal').classList.add('visible');
            // Clear previous inputs and status
            document.getElementById('reset-email').value = '';
            document.getElementById('reset-roll').value = '';
            document.getElementById('reset-univ-roll').value = '';
            document.getElementById('reset-status').classList.add('hidden');
        }

        function closeForgotPasswordModal() {
            document.getElementById('forgot-password-modal').classList.remove('visible');
        }

        document.getElementById('submit-reset-request').addEventListener('click', function () {
            const email = document.getElementById('reset-email').value.trim();
            const classRoll = document.getElementById('reset-roll').value.trim();
            const univRoll = document.getElementById('reset-univ-roll').value.trim();
            const statusDiv = document.getElementById('reset-status');

            if (!email || !classRoll || !univRoll) {
                showResetStatus('Please fill in all fields', 'error');
                return;
            }

            // First check if there's already a pending request
            const db = firebase.database();
            db.ref('passwordResetRequests').orderByChild('email').equalTo(email).once('value')
                .then((snapshot) => {
                    if (snapshot.exists()) {
                        const requests = snapshot.val();
                        const pendingRequest = Object.values(requests).find(req => req.status === 'pending');

                        if (pendingRequest) {
                            showResetStatus('A password reset request is already pending for this email', 'warning');
                            return;
                        }
                    }

                    // Verify user details
                    db.ref('users').orderByChild('email').equalTo(email).once('value')
                        .then((snapshot) => {
                            if (snapshot.exists()) {
                                const userData = Object.values(snapshot.val())[0];

                                if (userData.classRoll === classRoll && userData.univRoll === univRoll) {
                                    // Create password reset request
                                    const requestRef = db.ref('passwordResetRequests').push();
                                    requestRef.set({
                                        email: email,
                                        timestamp: Date.now(),
                                        status: 'pending',
                                        classRoll: classRoll,
                                        univRoll: univRoll
                                    })
                                        .then(() => {
                                            showResetStatus('Password reset request submitted successfully. Please wait for admin approval.', 'success');
                                            setTimeout(() => {
                                                closeForgotPasswordModal();
                                            }, 3000);
                                        })
                                        .catch((error) => {
                                            showResetStatus('Error submitting request: ' + error.message, 'error');
                                        });
                                } else {
                                    showResetStatus('Invalid roll numbers. Please check and try again.', 'error');
                                }
                            } else {
                                showResetStatus('No account found with this email address', 'error');
                            }
                        })
                        .catch((error) => {
                            showResetStatus('Error verifying details: ' + error.message, 'error');
                        });
                })
                .catch((error) => {
                    showResetStatus('Error checking existing requests: ' + error.message, 'error');
                });
        });

        function showResetStatus(message, type) {
            const statusDiv = document.getElementById('reset-status');
            statusDiv.textContent = message;
            statusDiv.className = `status-indicator ${type}`;
            statusDiv.classList.remove('hidden');
        }

        // Close modal when clicking outside
        document.getElementById('forgot-password-modal').addEventListener('click', function (e) {
            if (e.target === this) {
                closeForgotPasswordModal();
            }
        });

        const androidDownloadModal = document.getElementById('android-download-modal');
        const closeAndroidDownloadBtn = document.getElementById('close-android-download');
        const dismissAndroidDownloadBtn = document.getElementById('android-download-dismiss');

        if (closeAndroidDownloadBtn) {
            closeAndroidDownloadBtn.addEventListener('click', () => {
                hideAndroidDownloadModal();
            });
        }

        if (dismissAndroidDownloadBtn) {
            dismissAndroidDownloadBtn.addEventListener('click', () => {
                hideAndroidDownloadModal();
            });
        }

        if (androidDownloadModal) {
            androidDownloadModal.addEventListener('click', function (e) {
                if (e.target === this) {
                    hideAndroidDownloadModal();
                }
            });
        }

// History Logic
        let currentHistoryMonth = new Date().getMonth();
        let currentHistoryYear = new Date().getFullYear();

        const historyBtn = document.getElementById('history-btn');
        if (historyBtn) {
            historyBtn.addEventListener('click', () => {
                document.getElementById('history-modal').classList.add('visible');
                initHistoryControls();
                loadAttendanceHistory();
            });
        }

        const closeHistoryBtn = document.getElementById('close-history-btn');
        if (closeHistoryBtn) {
            closeHistoryBtn.addEventListener('click', () => {
                document.getElementById('history-modal').classList.remove('visible');
            });
        }

        // Close history modal on outside click
        const historyModal = document.getElementById('history-modal');
        if (historyModal) {
            historyModal.addEventListener('click', function (e) {
                if (e.target === this) {
                    this.classList.remove('visible');
                }
            });
        }

        function initHistoryControls() {
            const yearSelect = document.getElementById('history-year');
            const monthSelect = document.getElementById('history-month');

            if (!yearSelect || !monthSelect) return;

            // Populate years (Current - 1 to Current + 1)
            yearSelect.innerHTML = '';
            for (let y = currentHistoryYear - 1; y <= currentHistoryYear + 1; y++) {
                const opt = document.createElement('option');
                opt.value = y;
                opt.innerText = y;
                if (y === currentHistoryYear) opt.selected = true;
                yearSelect.appendChild(opt);
            }

            monthSelect.value = currentHistoryMonth;

            // Listener
            const loadBtn = document.getElementById('load-history-btn');
            if (loadBtn) loadBtn.onclick = loadAttendanceHistory;
        }

        function normalizeSectionList(sectionValue) {
            if (Array.isArray(sectionValue)) {
                return sectionValue.map(value => String(value).trim()).filter(Boolean);
            }
            if (sectionValue && typeof sectionValue === 'object') {
                const values = Object.values(sectionValue);
                const keys = Object.keys(sectionValue);
                const allBooleans = values.length && values.every(value => typeof value === 'boolean');
                if (allBooleans) {
                    return keys.filter(key => sectionValue[key]).map(value => String(value).trim()).filter(Boolean);
                }
                return values.map(value => String(value).trim()).filter(Boolean);
            }
            if (typeof sectionValue === 'string') {
                const trimmed = sectionValue.trim();
                if (!trimmed) return [];
                if (trimmed.includes(',')) {
                    return trimmed.split(',').map(value => value.trim()).filter(Boolean);
                }
                return [trimmed];
            }
            return [];
        }

        function normalizeSectionKeys(sectionValue) {
            return normalizeSectionList(sectionValue)
                .map(value => {
                    let trimmed = String(value).trim();
                    if (!trimmed) return '';
                    const lower = trimmed.toLowerCase();
                    if (lower.startsWith('section ')) {
                        trimmed = trimmed.slice(8).trim();
                    }
                    return trimmed.toLowerCase();
                })
                .filter(Boolean);
        }

        function parseScheduleTime(value) {
            if (!value) return null;
            if (value instanceof Date && !isNaN(value)) return value;
            if (value && typeof value === 'object') {
                if (typeof value.seconds === 'number' && Number.isFinite(value.seconds)) {
                    return new Date(value.seconds * 1000);
                }
                if (typeof value._seconds === 'number' && Number.isFinite(value._seconds)) {
                    return new Date(value._seconds * 1000);
                }
                if (typeof value.milliseconds === 'number' && Number.isFinite(value.milliseconds)) {
                    return new Date(value.milliseconds);
                }
                if (typeof value.ms === 'number' && Number.isFinite(value.ms)) {
                    return new Date(value.ms);
                }
                if (typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)) {
                    return new Date(value.timestamp);
                }
                if (typeof value.iso === 'string' && value.iso.trim()) {
                    const parsedIso = new Date(value.iso.trim());
                    if (!isNaN(parsedIso)) {
                        return parsedIso;
                    }
                }
            }
            if (typeof value === 'number' && Number.isFinite(value)) {
                return new Date(value);
            }
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (!trimmed) return null;
                if (/^\d+$/.test(trimmed)) {
                    const num = Number(trimmed);
                    if (Number.isFinite(num)) {
                        return new Date(num);
                    }
                }
                const parsed = new Date(trimmed);
                if (!isNaN(parsed)) {
                    return parsed;
                }
            }
            return null;
        }

        function getScheduleInfo(location) {
            if (!location) return { start: null, hasValue: false };
            const raw =
                location.scheduledStart ||
                location.scheduled_start ||
                location.startTime ||
                location.start_time;
            const hasValue = raw !== null && raw !== undefined && String(raw).trim() !== '';
            const start = parseScheduleTime(raw);
            return { start, hasValue };
        }

        function getScheduledStart(location) {
            return getScheduleInfo(location).start;
        }

        function loadAttendanceHistory() {
            if (!currentUser) return;

            const month = parseInt(document.getElementById('history-month').value);
            const year = parseInt(document.getElementById('history-year').value);
            const listEl = document.getElementById('history-list');

            listEl.innerHTML = '<div style="text-align:center; padding:20px; color: var(--gray-600);"><i class="fas fa-spinner fa-spin"></i> Loading records...</div>';

            const promises = [
                firebase.database().ref('attendance_by_location').once('value'),
                firebase.database().ref('locations').once('value')
            ];

            Promise.all(promises).then(([globalSnap, locSnap]) => {
                const globalData = globalSnap.val() || {};
                const locations = locSnap.val() || {};

                let records = [];
                const processedKeys = new Set(); // To avoid duplicates

                // Normalize User Section
            const userSectionKeys = normalizeSectionKeys(currentUser.section || '');

                // Iterate Global Attendance to find ALL class sessions
                Object.keys(globalData).forEach(locId => {
                    const locDates = globalData[locId];
                    const locMeta = locations[locId] || { name: 'Unknown Class' };
                    const locNameLower = (locMeta.name || '').toLowerCase();
                    const locSectionKeys = normalizeSectionKeys(locMeta.section);

                    Object.keys(locDates).forEach(dateStr => {
                        const date = new Date(dateStr);
                        // Check date validity and match selected month/year
                        if (isNaN(date) || date.getFullYear() !== year || date.getMonth() !== month) return;

                        const sessionAttendees = locDates[dateStr];
                        const attendeesList = Object.values(sessionAttendees);

                        // Determine relevance
                        const isUserPresent = !!sessionAttendees[currentUser.uid];

                        // Check Peers: Case-insensitive comparison
                        const hasPeerFromSection = userSectionKeys.length > 0 && attendeesList.some(a => {
                            const peerKeys = normalizeSectionKeys(a.section);
                            return userSectionKeys.some(key => peerKeys.includes(key));
                        });

                        // Check for 'General' applicability
                        const isGeneral = locSectionKeys.includes('general') ||
                            attendeesList.some(a => normalizeSectionKeys(a.section).includes('general')) ||
                            locNameLower.includes('general');

                        if (isUserPresent || hasPeerFromSection || isGeneral) {
                            const uniqueKey = dateStr + "_" + locId;
                            if (processedKeys.has(uniqueKey)) return;
                            processedKeys.add(uniqueKey);

                            if (isUserPresent) {
                                const userRecord = sessionAttendees[currentUser.uid];
                                records.push({
                                    ...userRecord,
                                    locationName: locMeta.name,
                                    status: userRecord.status || 'present', // Use actual status or default to present
                                    date: dateStr
                                });
                            } else {
                                // Absent Record (No record found)
                                const refRecord = attendeesList[0] || { timestamp: date.getTime(), time: '00:00:00' };
                                records.push({
                                    locationName: locMeta.name,
                                    date: dateStr,
                                    time: refRecord.time,
                                    timestamp: refRecord.timestamp,
                                    status: 'absent',
                                    attendanceType: 'Missed'
                                });
                            }
                        }
                    });
                });

                // Sort descending (newest first)
                records.sort((a, b) => b.timestamp - a.timestamp);

                renderHistoryList(records);
            }).catch(e => {
                console.error("History fetch error:", e);
                listEl.innerHTML = '<div class="status-indicator error">Failed to load history.</div>';
            });
        }

        function renderHistoryList(records) {
            const listEl = document.getElementById('history-list');
            if (records.length === 0) {
                listEl.innerHTML = `
                    <div class="empty-state" style="text-align: center; padding: 20px; color: var(--gray-500);">
                        <i class="fas fa-clipboard" style="font-size: 2rem; margin-bottom: 10px; display: block;"></i>
                        No class records found for this month.
                    </div>`;
                updateHistoryStats(0, 0);
                return;
            }

            let html = '';
            let presentCount = 0;

            records.forEach(r => {
                const date = new Date(r.date);
                const displayDate = date.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });

                if (r.status === 'present' || r.status === 'late') presentCount++;

                let statusClass = r.status || 'absent';
                let iconClass = 'fa-times-circle';
                let statusText = 'Absent';

                if (r.status === 'present') {
                    iconClass = 'fa-check-circle';
                    statusText = 'Present';
                } else if (r.status === 'late') {
                    iconClass = 'fa-clock';
                    statusText = 'Late';
                } else {
                    // Default to 'absent'
                    statusClass = 'absent';
                    iconClass = 'fa-times-circle';
                    statusText = 'Absent';
                }

                html += `
                    <div class="history-item">
                        <div>
                            <div class="history-date">${displayDate}</div>
                            <div class="history-time" style="font-weight: 600; color: var(--primary-color);">${r.locationName}</div>
                            <div style="font-size: 0.75rem; color: #999;">${r.time} • ${r.attendanceType || 'Unknown'}</div>
                        </div>
                        <div class="history-status ${statusClass}">
                            <i class="fas ${iconClass}"></i> ${statusText}
                        </div>
                    </div>
                `;
            });
            listEl.innerHTML = html;
            updateHistoryStats(presentCount, records.length);
        }

        function updateHistoryStats(presentCount, totalCount) {
            const presentEl = document.getElementById('stat-present');
            const totalEl = document.getElementById('stat-total');
            const percEl = document.getElementById('stat-percentage');

            if (presentEl) presentEl.innerText = presentCount;
            if (totalEl) totalEl.innerText = totalCount;

            if (percEl) {
                const percentage = totalCount > 0 ? Math.round((presentCount / totalCount) * 100) : 0;
                percEl.innerText = `${percentage}%`;

                // Color coding for percentage
                if (percentage >= 75) percEl.style.color = 'var(--success-color)';
                else if (percentage >= 60) percEl.style.color = 'var(--warning-color)';
                else percEl.style.color = 'var(--error-color)';
            }
        }


