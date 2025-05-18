import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Observable, Subject, Subscription, take, takeUntil, timer } from 'rxjs';
import { IDBUserService } from '../../services/IDB/IDBuser.service';
import { GeoService } from '../../services/map services/geo.service';
import { PwaInstallerService } from '../../services/admin services/pwa-installer.service';
import { InitializationService } from '../../services/admin services/initialization.service';
import { CurrentUserService } from '../../services/firestore/users/current-user.service';
import { FirebaseUserActivityService } from '../../services/admin services/firebase-user-activity.service';
import { doc, Firestore, getDoc } from '@angular/fire/firestore';

interface UserProfileData {
  createdAt: string;
  fcmToken: string;
  uid: string;
  userMarkerLat: number;
  userMarkerLon: number;
  userName: string;
}

@Component({
  selector: 'app-idle',
  templateUrl: './idle.component.html',
  styleUrls: ['./idle.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
  ]
})

export class IdleComponent implements OnInit {

  @Output() reload = new EventEmitter<void>();
  @Input() disabled: boolean = false;
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'user_database';
  private readonly STORE_NAME = 'user_store';
  private readonly DB_VERSION = 1;
  userData: UserProfileData | null = null;
  isRotating: boolean = false;
  userProfile$: Observable<UserProfileData | null>;
  loading = false;
  private destroy$ = new Subject<void>();
  private subscriptions: Subscription[] = [];

  constructor(
    private _router: Router,
    private _IDBUserService: IDBUserService,
    private _geoService: GeoService,
    public _pwaInstaller: PwaInstallerService,
    private _initializationService: InitializationService,
    private _currentUserService: CurrentUserService,
    private _firebaseUserActivityService: FirebaseUserActivityService,
    private _firestore: Firestore
  ) {
    this.userProfile$ = this._IDBUserService.getCurrentUserDataFromIDB();
  }

  ngOnInit() {
    // console.log('Initial canInstall state:', this._pwaInstaller.canInstall());
    this._pwaInstaller.canInstallState.subscribe(state => {
      // console.log('canInstall state changed:', state);
    });

    // Check if we're coming from logout flow
    const isFromLogout = localStorage.getItem('fromLogout') === 'true';
    if (isFromLogout) {
      // Clear the flag
      localStorage.removeItem('fromLogout');
      //  console.log('Coming from logout flow');
      // Don't return early - we still need to check IDB state
    }

    this.resetToVirginState();

    // Always check userProfile$ to ensure UI consistency with IDB state
    this.userProfile$.pipe(take(1)).subscribe(userData => {
      if (userData) {
        // console.log('User profile loaded from IndexedDB:', userData);
        this.userData = userData;
      } else {
        //  console.log('No user data available in IndexedDB, checking localStorage...');
        // Try to get data from localStorage as fallback
        try {
          const localStorageUserData = localStorage.getItem('currentUserData');
          if (localStorageUserData) {
            const parsedUserData = JSON.parse(localStorageUserData);
            //  console.log('User profile loaded from localStorage:', parsedUserData);
            this.userData = parsedUserData;

            // Optionally: restore the data back to IndexedDB
            this._IDBUserService.copyUserDataFromLocalStorageToIDB(parsedUserData).subscribe({
              //  next: () => console.log('Successfully restored user data from localStorage to IndexedDB'),
              error: err => console.error('Error restoring user data to IndexedDB:', err)
            });

            // Update current user service with the recovered data
            const uid = parsedUserData.uid || (parsedUserData.value && parsedUserData.value.uid);
            const userName = parsedUserData.userName || (parsedUserData.value && parsedUserData.value.userName);
            const userMarkerLat = parsedUserData.userMarkerLat || (parsedUserData.value && parsedUserData.value.userMarkerLat) || 0;
            const userMarkerLon = parsedUserData.userMarkerLon || (parsedUserData.value && parsedUserData.value.userMarkerLon) || 0;

            if (uid && userName) {
              this._currentUserService.setCurrentUser(uid, userName, userMarkerLat, userMarkerLon);
              this._currentUserService.setCurrentUserData(parsedUserData);
            }
          } else {
            //  console.log('No user data available in localStorage either');
            this.userData = null;
          }
        } catch (error) {
          console.error('Error retrieving user data from localStorage:', error);
          this.userData = null;
        }
      }
    });

    setTimeout(() => {
      this.startInitialization();
    }, 1000);
  }

  private startInitialization(): void {
    // console.log('[AppLoadingComponent] Starting initialization...');
    this._initializationService.resetInitialization();
    // Add the new startInitialization method call
    this._initializationService.startInitialization();
    // Set a timer to proceed regardless after 8 seconds
    timer(8000).pipe(take(1), takeUntil(this.destroy$)).subscribe(() => {
      //console.log('[AppLoadingComponent] Timer-based navigation triggered');

      // If we're proceeding due to timeout but initialization hasn't completed,
      // we should make sure the user ID is set in the Firebase activity service
      const userId = this._currentUserService.getCurrentUserID();
      if (userId && !this._currentUserService.getCurrentUserID()) {
        //  console.log('[AppLoadingComponent] Setting user ID in activity service');
        this._firebaseUserActivityService.setUserId(userId);
      }

    });
  }

  async reloadApp(): Promise<void> {
    if (this.disabled) return;

    // 1. Press animation
    this.disabled = true;
    const button = document.querySelector('.idle-button') as HTMLElement;
    button.classList.add('pressed');

    // 2. Wait for press animation (150ms) + release animation (300ms)
    await new Promise(resolve => setTimeout(resolve, 450));

    // 3. Return to normal state
    button.classList.remove('pressed');

    // 4. Wait briefly before navigation (100ms pause at raised state)
    await new Promise(resolve => setTimeout(resolve, 100));

    // 5. Execute navigation
    try {
      this.reload.emit();

      if (!this.userData?.uid) {
        await this._router.navigate(['/loading']);
      } else {
        // Check if user document exists in Firestore
        const userDocRef = doc(this._firestore, 'userMarkers', this.userData.uid);
        const userDocSnap = await getDoc(userDocRef);

        if (!userDocSnap.exists()) {
          // No user document exists, call ngOnInit to reinitialize the component
          this.ngOnInit();
          await this._router.navigate(['/loading']);
        } else {
          await this._router.navigate(['/loading']);
          //await this._sessionManagementService.initializeSessionManagement(this.userData.uid);
        }
      }
    } catch (error) {
      console.error('Navigation error:', error);
    } finally {
      this.disabled = false;
    }
  }

  async installApp() {
    try {
      // Record PWA install attempt analytics first
      // console.log('Recording PWA install attempt');

      if (this._pwaInstaller.canInstall()) {
        const installed = await this._pwaInstaller.installPwa();

        if (installed) {
          // Record successful installation
          // console.log('PWA installation successful');
          // Here you might want to update your UI or show a success message
        } else {
          // Record cancelled installation
          // console.log('PWA installation cancelled');
          // Maybe show a message encouraging them to install later
        }
      } else {
        // Record that installation wasn't possible

        // console.log('PWA cannot be installed right now');
        // Log why it can't be installed
        // console.log('Is browser?', this._pwaInstaller.platform.isBrowser);
        // console.log('Install prompt available?', this._pwaInstaller.deferredPrompt !== null);
        // console.log('Already installed?', sessionStorage.getItem('pwa-hide-install') === 'true');
      }
    } catch (error: unknown) {
      console.error('Error during PWA installation:', error);

      // Try to record the error (but don't throw if this fails)
      try {

      } catch {
        // Silently ignore analytics errors here
      }
    }
  }

  navigateToMap() {
    const { userMarkerLat: lat, userMarkerLon: lon } = this.userData as { userMarkerLat: number; userMarkerLon: number };

    this._geoService.setCoords(lat, lon);
    this._router.navigate(['/map'], { queryParams: { lat, lon } });
  }

  private resetToVirginState() {
    // Clear all existing subscriptions
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];

    // Reset all properties to initial values
    // property1 = initialValue1;
    // property2 = initialValue2;

    // Clear any timers
    // if (this.timer) clearTimeout(this.timer);

    console.log('Idle component reset to virgin state');
  }


  ngOnDestroy() {
    // Clean up subscriptions
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

}