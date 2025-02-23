aicommits:
	git add .
	aicommits --all
	git push origin

build:
	pnpm run build

install_global:
	pnpm link --global
