CC := gcc
.PHONY: all test lint
all: app
app: main.c
	$(CC) -o app main.c
test: app
	./app --self-test
lint:
	cppcheck .
