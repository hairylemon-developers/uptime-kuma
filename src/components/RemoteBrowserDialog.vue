<template>
    <form @submit.prevent="submit">
        <div ref="modal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 id="exampleModalLabel" class="modal-title">
                            {{ $t("Add a Remote Browser") }}
                        </h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('Close')" />
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <label for="remote-browser-name" class="form-label">{{ $t("Friendly Name") }}</label>
                            <input
                                id="remote-browser-name"
                                v-model="remoteBrowser.name"
                                type="text"
                                class="form-control"
                                required
                            />
                        </div>

                        <div class="mb-3">
                            <label for="remote-browser-engine" class="form-label">{{
                                $t("remoteBrowserEngine")
                            }}</label>
                            <select
                                id="remote-browser-engine"
                                v-model="remoteBrowser.engine"
                                class="form-select"
                                required
                            >
                                <option value="chromium">
                                    {{ $t("browserEngineChromium") }}
                                </option>
                                <option value="kitesurf">
                                    {{ $t("browserEngineKitesurf") }}
                                </option>
                            </select>
                            <div class="form-text">
                                {{ $t("remoteBrowserEngineDescription") }}
                            </div>
                        </div>

                        <div class="mb-3">
                            <label for="remote-browser-url" class="form-label">{{ $t("URL") }}</label>
                            <input
                                id="remote-browser-url"
                                v-model="remoteBrowser.url"
                                type="text"
                                class="form-control"
                                required
                            />

                            <i18n-t tag="div" keypath="Example:" class="form-text mt-3">
                                <code v-if="remoteBrowser.engine === 'kitesurf'">{{ kitesurfExample }}</code>
                                <code v-else>{{ chromiumExample }}</code>
                            </i18n-t>
                        </div>
                    </div>

                    <div class="modal-footer">
                        <button
                            v-if="id"
                            type="button"
                            class="btn btn-danger"
                            :disabled="processing"
                            @click="deleteConfirm"
                        >
                            {{ $t("Delete") }}
                        </button>
                        <button type="button" class="btn btn-warning" :disabled="processing" @click="test">
                            {{ $t("Test") }}
                        </button>
                        <button type="submit" class="btn btn-primary" :disabled="processing">
                            <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                            {{ $t("Save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    <Confirm
        ref="confirmDelete"
        btn-style="btn-danger"
        :yes-text="$t('Yes')"
        :no-text="$t('No')"
        @yes="deleteDockerHost"
    >
        {{ $t("deleteRemoteBrowserMessage") }}
    </Confirm>
</template>

<script>
import { Modal } from "bootstrap";
import Confirm from "./Confirm.vue";

export default {
    components: {
        Confirm,
    },
    props: {},
    emits: ["added"],
    data() {
        return {
            modal: null,
            processing: false,
            id: null,
            chromiumExample: "ws://chrome.browserless.io/playwright?token=YOUR-API-TOKEN",
            kitesurfExample: "ws://127.0.0.1:8787/devtools/browser",
            remoteBrowser: {
                name: "",
                url: "",
                engine: "chromium",
            },
        };
    },

    mounted() {
        this.modal = new Modal(this.$refs.modal);
    },
    methods: {
        /**
         * Confirm deletion of docker host
         * @returns {void}
         */
        deleteConfirm() {
            this.modal.hide();
            this.$refs.confirmDelete.show();
        },

        /**
         * Show specified remote browser
         * @param {number} remoteBrowserID ID of host to show
         * @param {"chromium"|"kitesurf"} [defaultEngine="chromium"] Engine for new remotes
         * @returns {void}
         */
        show(remoteBrowserID, defaultEngine = "chromium") {
            if (remoteBrowserID) {
                let found = false;

                this.id = remoteBrowserID;

                for (let n of this.$root.remoteBrowserList) {
                    if (n.id === remoteBrowserID) {
                        this.remoteBrowser = {
                            ...n,
                            engine: n.engine === "kitesurf" ? "kitesurf" : "chromium",
                        };
                        found = true;
                        break;
                    }
                }

                if (!found) {
                    this.$root.toastError(this.$t("Remote Browser not found!"));
                }
            } else {
                this.id = null;
                this.remoteBrowser = {
                    name: "",
                    url: "",
                    engine: defaultEngine === "kitesurf" ? "kitesurf" : "chromium",
                };
            }

            this.modal.show();
        },

        /**
         * Add docker host
         * @returns {void}
         */
        submit() {
            this.processing = true;
            this.$root.getSocket().emit("addRemoteBrowser", this.remoteBrowser, this.id, (res) => {
                this.$root.toastRes(res);
                this.processing = false;

                if (res.ok) {
                    this.modal.hide();

                    // Emit added event, doesn't emit edit.
                    if (!this.id) {
                        this.$emit("added", res.id);
                    }
                }
            });
        },

        /**
         * Test the docker host
         * @returns {void}
         */
        test() {
            this.processing = true;
            this.$root.getSocket().emit("testRemoteBrowser", this.remoteBrowser, (res) => {
                this.$root.toastRes(res);
                this.processing = false;
            });
        },

        /**
         * Delete this docker host
         * @returns {void}
         */
        deleteDockerHost() {
            this.processing = true;
            this.$root.getSocket().emit("deleteRemoteBrowser", this.id, (res) => {
                this.$root.toastRes(res);
                this.processing = false;

                if (res.ok) {
                    this.modal.hide();
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.dark {
    .modal-dialog .form-text,
    .modal-dialog p {
        color: $dark-font-color;
    }
}
</style>
