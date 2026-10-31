defmodule Acme.MixProject do
  defp deps do
    [{:phoenix, "~> 1.7"}, {:credo, "~> 1.7", only: [:dev, :test]}]
  end
end
