SERVICE       = gym
SERVICE_FILE  = $(SERVICE).service
USER_UNIT_DIR = $(HOME)/.config/systemd/user

.PHONY: install-service deploy dev logs status

install-service:
	mkdir -p $(USER_UNIT_DIR)
	cp $(SERVICE_FILE) $(USER_UNIT_DIR)/$(SERVICE_FILE)
	systemctl --user daemon-reload
	systemctl --user enable --now $(SERVICE)

deploy:
	podman-compose build
	systemctl --user restart $(SERVICE)

dev:
	PORT=8001 node server.js

logs:
	podman logs -f $(SERVICE)

status:
	systemctl --user status $(SERVICE) --no-pager
